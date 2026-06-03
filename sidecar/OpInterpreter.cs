using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;

namespace FlaUiSidecar;

/// <summary>
/// Maps structured JSON ops (the seam, ADR-003) to FlaUI calls. Skeleton supports `find` only;
/// attributes/action/source/input arrive in later phases.
/// AUTHORED ON macOS — requires Windows + FlaUI to build/run.
/// </summary>
public sealed class OpInterpreter
{
    private readonly AutomationBase _automation;
    private readonly ElementRegistry _registry;
    private AutomationElement? _root;

    public OpInterpreter(AutomationBase automation, ElementRegistry registry)
    {
        _automation = automation;
        _registry = registry;
    }

    public object OpenSession(AutomationElement root)
    {
        _root = root;
        return new { rootId = _registry.Register(root) };
    }

    /// <summary>Best-effort close of the session root window (used for attached sessions).</summary>
    public void CloseRootWindow()
    {
        try { _root?.Patterns.Window.PatternOrDefault?.Close(); } catch { /* best effort */ }
    }

    public object Find(JsonElement op)
    {
        var startId = op.GetProperty("startId").GetString()!;
        var multiple = op.GetProperty("multiple").GetBoolean();
        var scope = ParseScope(op.GetProperty("scope").GetString()!);
        var start = startId == "root" ? _root! : ResolveOrThrow(startId);
        var cond = BuildCondition(op.GetProperty("condition"));

        if (multiple)
        {
            var els = start.FindAll(scope, cond);
            return new { elements = els.Select(Basic).ToArray() };
        }

        var found = start.FindFirst(scope, cond) ?? throw new ElementNotFoundException();
        return Basic(found);
        // Note: FlaUI 4.x has no ElementNotFoundException; FindFirst signals "not found" by returning
        // null. We raise a sidecar-local ElementNotFoundException (below) so Program.cs maps it to the
        // W3C "no such element" error envelope.
    }

    /// <summary>Bulk attribute fetch (Phase 2). `names` is an array, or "all".</summary>
    public object Attributes(JsonElement op)
    {
        var el = ResolveOrThrow(op.GetProperty("id").GetString()!);
        var namesEl = op.GetProperty("names");
        var dict = new Dictionary<string, object?>();
        if (namesEl.ValueKind == JsonValueKind.String && namesEl.GetString() == "all")
        {
            foreach (var n in AllAttributeNames) dict[n] = ReadAttribute(el, n);
        }
        else
        {
            foreach (var n in namesEl.EnumerateArray()) dict[n.GetString()!] = ReadAttribute(el, n.GetString()!);
        }
        return dict;
    }

    /// <summary>Element action via a UIA pattern. Write-style actions return {done:true}; read-style
    /// actions (getValue/isMultiple/selection/getAttributes) return their data.</summary>
    public object? Action(JsonElement op)
    {
        var el = ResolveOrThrow(op.GetProperty("id").GetString()!);
        var action = op.GetProperty("action").GetString();
        var args = op.TryGetProperty("args", out var a) ? a : default;
        switch (action)
        {
            // ── read-style ──
            case "getValue":
                return new { value = el.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault };
            case "isMultiple":
                return new { value = el.Patterns.Selection.PatternOrDefault?.CanSelectMultiple.ValueOrDefault };
            case "selectedItem":
            {
                var sel = el.Patterns.Selection.PatternOrDefault?.Selection.ValueOrDefault;
                return sel is { Length: > 0 } ? Basic(sel[0]) : null;
            }
            case "allSelectedItems":
            {
                var sel = el.Patterns.Selection.PatternOrDefault?.Selection.ValueOrDefault
                          ?? Array.Empty<AutomationElement>();
                return new { elements = sel.Select(Basic).ToArray() };
            }
            case "getAttributes":
            {
                var dict = new Dictionary<string, object?>();
                foreach (var n in AllAttributeNames) dict[n] = ReadAttribute(el, n);
                return dict;
            }
            // ── write-style ──
            case "invoke": el.Patterns.Invoke.Pattern.Invoke(); break;
            case "toggle": el.Patterns.Toggle.Pattern.Toggle(); break;
            case "expand": el.Patterns.ExpandCollapse.Pattern.Expand(); break;
            case "collapse": el.Patterns.ExpandCollapse.Pattern.Collapse(); break;
            case "select": el.Patterns.SelectionItem.Pattern.Select(); break;
            case "addToSelection": el.Patterns.SelectionItem.Pattern.AddToSelection(); break;
            case "removeFromSelection": el.Patterns.SelectionItem.Pattern.RemoveFromSelection(); break;
            case "scrollIntoView": el.Patterns.ScrollItem.Pattern.ScrollIntoView(); break;
            case "setFocus": el.Focus(); break;
            case "setValue": el.Patterns.Value.Pattern.SetValue(args.GetProperty("value").GetString()); break;
            case "maximize": el.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Maximized); break;
            case "minimize": el.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Minimized); break;
            case "restore": el.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Normal); break;
            case "close": el.Patterns.Window.Pattern.Close(); break;
            default: throw new ArgumentException($"unsupported action: {action}");
        }
        return new { done = true };
    }

    /// <summary>Tree walking for XPath reverse/sibling axes (control view, ordered).</summary>
    public object Walk(JsonElement op)
    {
        var el = ResolveOrThrow(op.GetProperty("id").GetString()!);
        var direction = op.GetProperty("direction").GetString();
        var walker = _automation.TreeWalkerFactory.GetControlViewWalker();
        var list = new List<AutomationElement>();
        switch (direction)
        {
            case "parent":
            {
                var p = walker.GetParent(el);
                if (p is not null) list.Add(p);
                break;
            }
            case "ancestors":
            {
                var p = walker.GetParent(el);
                while (p is not null) { list.Add(p); p = walker.GetParent(p); }
                break;
            }
            case "following-siblings":
            {
                var s = walker.GetNextSibling(el);
                while (s is not null) { list.Add(s); s = walker.GetNextSibling(s); }
                break;
            }
            case "preceding-siblings":
            {
                var s = walker.GetPreviousSibling(el);
                while (s is not null) { list.Add(s); s = walker.GetPreviousSibling(s); }
                break;
            }
            default: throw new ArgumentException($"unsupported walk direction: {direction}");
        }
        return new { elements = list.Select(Basic).ToArray() };
    }

    /// <summary>Session-window commands: the W3C window endpoints operate on the session root window.</summary>
    public object? Window(JsonElement op)
    {
        var root = _root!;
        var action = op.GetProperty("action").GetString();
        switch (action)
        {
            case "title":
                return new { value = root.Properties.Name.ValueOrDefault ?? string.Empty };
            case "handle":
                return new { value = "0x" + root.Properties.NativeWindowHandle.ValueOrDefault.ToInt64().ToString("X") };
            case "rect":
                return RectOf(root);
            case "setRect":
            {
                var t = root.Patterns.Transform.PatternOrDefault;
                var a = op.GetProperty("args");
                if (a.TryGetProperty("x", out var x) && a.TryGetProperty("y", out var y) && t?.CanMove.ValueOrDefault == true)
                    t.Move(x.GetDouble(), y.GetDouble());
                if (a.TryGetProperty("width", out var w) && a.TryGetProperty("height", out var h) && t?.CanResize.ValueOrDefault == true)
                    t.Resize(w.GetDouble(), h.GetDouble());
                return RectOf(root);
            }
            case "maximize":
                root.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Maximized);
                return RectOf(root);
            case "minimize":
                root.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Minimized);
                return RectOf(root);
            default: throw new ArgumentException($"unsupported window action: {action}");
        }
    }

    /// <summary>Real mouse/keyboard input via FlaUI.Core.Input (ADR-005 rev.1). Requires an interactive
    /// desktop session. Element-targeted points default to the element's center.</summary>
    public object? Input(JsonElement op)
    {
        var kind = op.GetProperty("kind").GetString();
        var args = op.GetProperty("args");
        switch (kind)
        {
            case "click":
            {
                var pt = ResolvePoint(args);
                var button = args.TryGetProperty("button", out var b) && b.GetString() == "right"
                    ? MouseButton.Right : MouseButton.Left;
                var times = args.TryGetProperty("times", out var t) ? t.GetInt32() : 1;
                Mouse.MoveTo(pt);
                for (var i = 0; i < times; i++) Mouse.Click(button);
                return new { done = true };
            }
            case "hover":
            case "move":
                Mouse.MoveTo(ResolvePoint(args));
                return new { done = true };
            case "down":
                Mouse.Down(ButtonOf(args));
                return new { done = true };
            case "up":
                Mouse.Up(ButtonOf(args));
                return new { done = true };
            case "scroll":
            {
                if (args.TryGetProperty("elementId", out _) || args.TryGetProperty("x", out _))
                    Mouse.MoveTo(ResolvePoint(args));
                var dy = args.TryGetProperty("deltaY", out var dyv) ? dyv.GetDouble() : 0;
                var dx = args.TryGetProperty("deltaX", out var dxv) ? dxv.GetDouble() : 0;
                if (dy != 0) Mouse.Scroll(dy);
                if (dx != 0) Mouse.HorizontalScroll(dx);
                return new { done = true };
            }
            case "keys":
            {
                foreach (var a in args.GetProperty("actions").EnumerateArray())
                {
                    if (a.TryGetProperty("pause", out var pz)) { Thread.Sleep(pz.GetInt32()); continue; }
                    if (a.TryGetProperty("text", out var tx)) { Keyboard.Type(tx.GetString()); continue; }
                    if (a.TryGetProperty("virtualKeyCode", out var vk))
                    {
                        var key = (VirtualKeyShort)vk.GetInt32();
                        if (a.TryGetProperty("down", out var dn))
                        {
                            if (dn.GetBoolean()) Keyboard.Press(key); else Keyboard.Release(key);
                        }
                        else { Keyboard.Press(key); Keyboard.Release(key); }
                    }
                }
                return new { done = true };
            }
            case "clickAndDrag":
            {
                var from = ResolvePointPrefixed(args, "start");
                var to = ResolvePointPrefixed(args, "end");
                Mouse.Drag(from, to);
                return new { done = true };
            }
            default: throw new ArgumentException($"unsupported input kind: {kind}");
        }
    }

    private static MouseButton ButtonOf(JsonElement args) =>
        args.TryGetProperty("button", out var b) && b.GetString() == "right" ? MouseButton.Right : MouseButton.Left;

    /// <summary>PNG screenshot (base64) of an element, or of the session root when no id is given.</summary>
    public object Screenshot(JsonElement op)
    {
        var el = op.TryGetProperty("id", out var id) && id.GetString() is { Length: > 0 } s
            ? ResolveOrThrow(s)
            : _root!;
        using var img = FlaUI.Core.Capturing.Capture.Element(el);
        using var ms = new MemoryStream();
        img.Bitmap.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
        return new { data = Convert.ToBase64String(ms.ToArray()) };
    }

    /// <summary>Clipboard get/set (base64-encoded). contentType 'plaintext' (default, UTF-8 via TextCopy)
    /// or 'image' (base64 PNG via Win32 clipboard P/Invoke + CF_DIB). nova2-compatible.</summary>
    public object Clipboard(JsonElement op)
    {
        var action = op.GetProperty("action").GetString();
        var contentType = (op.TryGetProperty("contentType", out var ct) && ct.GetString() is { Length: > 0 } c
            ? c : "plaintext").ToLowerInvariant();

        if (contentType == "image")
        {
            if (action == "set")
            {
                var bytes = Convert.FromBase64String(op.GetProperty("b64").GetString()!);
                ClipboardImage.SetPng(bytes);
                return new { done = true };
            }
            var png = ClipboardImage.GetPng();
            return new { b64 = png is null ? string.Empty : Convert.ToBase64String(png) };
        }

        // plaintext (default)
        if (action == "set")
        {
            var text = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(op.GetProperty("b64").GetString()!));
            TextCopy.ClipboardService.SetText(text);
            return new { done = true };
        }
        var t = TextCopy.ClipboardService.GetText() ?? string.Empty;
        return new { b64 = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(t)) };
    }

    /// <summary>File transfer (insecure feature, ADR-008): pull a file (→base64), push base64 to a file
    /// (creating parent dirs), or zip a folder to a temp file (→base64, temp deleted). Missing files/folders
    /// raise FileNotFoundException → mapped to the W3C "unknown error" envelope with a clear message.</summary>
    public object File(JsonElement op)
    {
        var action = op.GetProperty("action").GetString();
        var path = op.GetProperty("path").GetString()!;
        switch (action)
        {
            case "pull":
            {
                if (!System.IO.File.Exists(path))
                    throw new FileNotFoundException($"File not found: {path}");
                var bytes = System.IO.File.ReadAllBytes(path);
                return new { data = Convert.ToBase64String(bytes) };
            }
            case "push":
            {
                var data = op.GetProperty("data").GetString()!;
                var parent = System.IO.Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                System.IO.File.WriteAllBytes(path, Convert.FromBase64String(data));
                return new { done = true };
            }
            case "pullFolder":
            {
                if (!Directory.Exists(path))
                    throw new FileNotFoundException($"Folder not found: {path}");
                var zipPath = System.IO.Path.Combine(
                    System.IO.Path.GetTempPath(), $"appium_{Guid.NewGuid():N}.zip");
                try
                {
                    System.IO.Compression.ZipFile.CreateFromDirectory(path, zipPath);
                    var bytes = System.IO.File.ReadAllBytes(zipPath);
                    return new { data = Convert.ToBase64String(bytes) };
                }
                finally
                {
                    try { if (System.IO.File.Exists(zipPath)) System.IO.File.Delete(zipPath); }
                    catch { /* best effort */ }
                }
            }
            default: throw new ArgumentException($"unsupported file action: {action}");
        }
    }

    private System.Drawing.Point ResolvePoint(JsonElement args)
    {
        if (args.TryGetProperty("elementId", out var id) && id.GetString() is { Length: > 0 } s)
        {
            var el = ResolveOrThrow(s);
            var r = el.Properties.BoundingRectangle.ValueOrDefault;
            var x = args.TryGetProperty("x", out var xv) ? r.X + xv.GetInt32() : r.X + r.Width / 2;
            var y = args.TryGetProperty("y", out var yv) ? r.Y + yv.GetInt32() : r.Y + r.Height / 2;
            return new System.Drawing.Point(x, y);
        }
        return new System.Drawing.Point(args.GetProperty("x").GetInt32(), args.GetProperty("y").GetInt32());
    }

    private System.Drawing.Point ResolvePointPrefixed(JsonElement args, string prefix)
    {
        if (args.TryGetProperty($"{prefix}ElementId", out var id) && id.GetString() is { Length: > 0 } s)
        {
            var el = ResolveOrThrow(s);
            var r = el.Properties.BoundingRectangle.ValueOrDefault;
            var x = args.TryGetProperty($"{prefix}X", out var xv) ? r.X + xv.GetInt32() : r.X + r.Width / 2;
            var y = args.TryGetProperty($"{prefix}Y", out var yv) ? r.Y + yv.GetInt32() : r.Y + r.Height / 2;
            return new System.Drawing.Point(x, y);
        }
        return new System.Drawing.Point(
            args.GetProperty($"{prefix}X").GetInt32(),
            args.GetProperty($"{prefix}Y").GetInt32());
    }

    /// <summary>Page source as XML, built in one CacheRequest pass (Phase 2). Schema must match nova2.</summary>
    public object Source(JsonElement op)
    {
        var startId = op.GetProperty("startId").GetString()!;
        var rawView = op.TryGetProperty("rawView", out var r) && r.GetBoolean();
        var start = startId == "root" ? _root! : ResolveOrThrow(startId);
        var xml = PageSourceBuilder.Build(_automation, start, rawView);
        return new { source = xml };
    }

    private object Basic(AutomationElement e)
    {
        _registry.Register(e);
        return new
        {
            runtimeId = string.Join('.', e.Properties.RuntimeId.Value),
            name = e.Properties.Name.ValueOrDefault,
            automationId = e.Properties.AutomationId.ValueOrDefault,
            className = e.Properties.ClassName.ValueOrDefault,
            controlType = e.Properties.ControlType.ValueOrDefault.ToString(),
        };
    }

    private AutomationElement ResolveOrThrow(string id)
    {
        if (_registry.TryGet(id, out var el) && el is not null) return el;
        // Never-seen / malformed ids → "no such element"; well-formed runtime ids that aged out → "stale".
        if (System.Text.RegularExpressions.Regex.IsMatch(id, @"^\d+(\.\d+)*$"))
            throw new StaleElementException(id);
        throw new ElementNotFoundException();
    }

    private ConditionBase BuildCondition(JsonElement c)
    {
        var cf = _automation.ConditionFactory;
        return c.GetProperty("kind").GetString() switch
        {
            // FlaUI 4.x exposes a singleton match-all condition via TrueCondition.Default
            // (the ctor is private). FlaUI.Core.Conditions.
            "true" => TrueCondition.Default,
            "property" => BuildProperty(cf, c),
            "and" => c.GetProperty("children").EnumerateArray().Select(BuildCondition)
                       .Aggregate((a, b) => a.And(b)),
            "or" => c.GetProperty("children").EnumerateArray().Select(BuildCondition)
                      .Aggregate((a, b) => a.Or(b)),
            "not" => BuildCondition(c.GetProperty("child")).Not(),
            var k => throw new ArgumentException($"unknown condition kind: {k}"),
        };
    }

    /// <summary>Build a UIA PropertyCondition for any of the nova2-allowlisted properties, converting the
    /// JSON value to the property's native type (bool for Is*/HasKeyboardFocus, int for ProcessId, ...).</summary>
    private PropertyCondition BuildProperty(ConditionFactory cf, JsonElement c)
    {
        var prop = c.GetProperty("prop").GetString()!;
        var val = c.GetProperty("value");
        var lib = _automation.PropertyLibrary.Element;

        object value = prop switch
        {
            "IsEnabled" or "IsOffscreen" or "HasKeyboardFocus" or "IsContentElement" or "IsControlElement"
                or "IsKeyboardFocusable" or "IsPassword" or "IsRequiredForForm"
                => val.ValueKind == JsonValueKind.String ? bool.Parse(val.GetString()!) : val.GetBoolean(),
            "ProcessId" => val.ValueKind == JsonValueKind.String ? int.Parse(val.GetString()!) : val.GetInt32(),
            "ControlType" => Enum.Parse<ControlType>(val.GetString()!, ignoreCase: true),
            "RuntimeId" => val.GetString()!.Split('.').Select(int.Parse).ToArray(),
            _ => val.ValueKind switch
            {
                JsonValueKind.Number => val.GetDouble(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => val.GetString()!,
            },
        };

        var property = prop switch
        {
            "AutomationId" => lib.AutomationId,
            "Name" => lib.Name,
            "ClassName" => lib.ClassName,
            "ControlType" => lib.ControlType,
            "LocalizedControlType" => lib.LocalizedControlType,
            "FrameworkId" => lib.FrameworkId,
            "HelpText" => lib.HelpText,
            "ItemStatus" => lib.ItemStatus,
            "ItemType" => lib.ItemType,
            "AcceleratorKey" => lib.AcceleratorKey,
            "AccessKey" => lib.AccessKey,
            "IsEnabled" => lib.IsEnabled,
            "IsOffscreen" => lib.IsOffscreen,
            "IsKeyboardFocusable" => lib.IsKeyboardFocusable,
            "IsPassword" => lib.IsPassword,
            "IsRequiredForForm" => lib.IsRequiredForForm,
            "HasKeyboardFocus" => lib.HasKeyboardFocus,
            "IsContentElement" => lib.IsContentElement,
            "IsControlElement" => lib.IsControlElement,
            "ProcessId" => lib.ProcessId,
            "RuntimeId" => lib.RuntimeId,
            _ => throw new ArgumentException($"unsupported property: {prop}"),
        };
        return new PropertyCondition(property, value);
    }

    private static TreeScope ParseScope(string s) => s switch
    {
        "element" => TreeScope.Element,
        "children" => TreeScope.Children,
        "descendants" => TreeScope.Descendants,
        "subtree" => TreeScope.Subtree,
        _ => TreeScope.Descendants,
    };

    internal static readonly string[] AllAttributeNames =
    {
        "Name", "AutomationId", "ClassName", "ControlType", "LocalizedControlType",
        "RuntimeId", "IsEnabled", "IsOffscreen", "ProcessId", "FrameworkId", "HelpText",
        "AcceleratorKey", "AccessKey", "HasKeyboardFocus", "IsContentElement", "IsControlElement",
        "IsKeyboardFocusable", "IsPassword", "IsRequiredForForm", "ItemStatus", "ItemType", "Orientation",
    };

    /// <summary>Read a single attribute by its schema name. TODO (Windows pass): extend to pattern-specific
    /// attributes (e.g. Window.CanMaximize) and confirm property accessors.</summary>
    internal static object? ReadAttribute(AutomationElement el, string name) => name switch
    {
        "Name" => el.Properties.Name.ValueOrDefault,
        "AutomationId" => el.Properties.AutomationId.ValueOrDefault,
        "ClassName" => el.Properties.ClassName.ValueOrDefault,
        "ControlType" => el.Properties.ControlType.ValueOrDefault.ToString(),
        "LocalizedControlType" => el.Properties.LocalizedControlType.ValueOrDefault,
        "RuntimeId" => string.Join('.', el.Properties.RuntimeId.ValueOrDefault ?? Array.Empty<int>()),
        "IsEnabled" => el.Properties.IsEnabled.ValueOrDefault,
        "IsOffscreen" => el.Properties.IsOffscreen.ValueOrDefault,
        "ProcessId" => el.Properties.ProcessId.ValueOrDefault,
        "FrameworkId" => el.Properties.FrameworkId.ValueOrDefault,
        "HelpText" => el.Properties.HelpText.ValueOrDefault,
        // ValuePattern.Value — e.g. the text of an Edit control (lets getAttribute("Value") read it back).
        "Value" => el.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault,
        // SelectionItemPattern.IsSelected — null when the pattern is unsupported (treated as false upstream).
        "IsSelected" => el.Patterns.SelectionItem.PatternOrDefault?.IsSelected.ValueOrDefault,
        // BoundingRectangle as a plain {x,y,width,height} object (used by W3C getElementRect).
        "BoundingRectangle" => RectOf(el),
        // HWND as hex (used by the attach flow: read it, then re-attach via appTopLevelWindow).
        "NativeWindowHandle" => "0x" + el.Properties.NativeWindowHandle.ValueOrDefault.ToInt64().ToString("X"),
        "HasKeyboardFocus" => el.Properties.HasKeyboardFocus.ValueOrDefault,
        "AcceleratorKey" => el.Properties.AcceleratorKey.ValueOrDefault,
        "AccessKey" => el.Properties.AccessKey.ValueOrDefault,
        "IsContentElement" => el.Properties.IsContentElement.ValueOrDefault,
        "IsControlElement" => el.Properties.IsControlElement.ValueOrDefault,
        "IsKeyboardFocusable" => el.Properties.IsKeyboardFocusable.ValueOrDefault,
        "IsPassword" => el.Properties.IsPassword.ValueOrDefault,
        "IsRequiredForForm" => el.Properties.IsRequiredForForm.ValueOrDefault,
        "ItemStatus" => el.Properties.ItemStatus.ValueOrDefault,
        "ItemType" => el.Properties.ItemType.ValueOrDefault,
        "Orientation" => el.Properties.Orientation.ValueOrDefault.ToString(),
        _ => throw new ArgumentException($"unknown attribute: {name}"),
    };

    private static object RectOf(AutomationElement el)
    {
        var r = el.Properties.BoundingRectangle.ValueOrDefault;
        return new { x = (int)r.X, y = (int)r.Y, width = (int)r.Width, height = (int)r.Height };
    }
}

public sealed class StaleElementException(string id) : Exception($"stale element: {id}");

/// <summary>Raised when a single-element find yields no match (FlaUI's FindFirst returned null).
/// Mapped to the W3C "no such element" error in Program.cs.</summary>
public sealed class ElementNotFoundException() : Exception("no such element matched the condition");

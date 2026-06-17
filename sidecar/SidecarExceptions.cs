namespace FlaUiSidecar;

// FlaUI-free sidecar exception types. Kept in their own file (no FlaUI/UIA imports) so the cross-platform
// test project can reference them and so OpLogic's error classifier can be unit-tested. The W3C mapping
// lives in Program.cs RunOp (and is mirrored, testably, by OpLogic.ClassifyError).

/// <summary>Raised when a well-formed-but-unknown runtime id is requested (it aged out of the registry).
/// Mapped to the W3C "stale element reference" error in Program.cs.</summary>
public sealed class StaleElementException(string id) : Exception($"stale element: {id}");

/// <summary>Raised for a malformed/invalid argument (e.g. a non-hex appTopLevelWindow). Mapped to the
/// W3C "invalid argument" error in Program.cs (distinct from ArgumentException → "invalid selector").</summary>
public sealed class InvalidArgumentException(string message) : Exception(message);

/// <summary>Raised when a single-element find yields no match (FlaUI's FindFirst returned null).
/// Mapped to the W3C "no such element" error in Program.cs.</summary>
public sealed class ElementNotFoundException() : Exception("no such element matched the condition");

/// <summary>Raised when an op targets an element in a state that forbids it — e.g. Element Clear / replace
/// on a non-editable element (a Window/Pane/Button has no text to clear). Mapped to the W3C
/// "invalid element state" error in Program.cs (W3C §12.5.2).</summary>
public sealed class InvalidElementStateException(string message) : Exception(message);

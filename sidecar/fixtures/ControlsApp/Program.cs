// ControlsApp — a UIA-visible WinForms window that exposes a handful of controls for exercising the
// driver's UIA pattern commands.
//
// Used by tests/e2e/12-patterns.e2e.spec.ts to cover:
//   - ExpandCollapsePattern: a TreeView ("treeMain") whose "RootNode" TreeItem starts COLLAPSED, so an
//     expand test has something to do.
//   - Selection / SelectionItemPattern: a multi-select ListView ("listMulti", Details + MultiSelect)
//     starting with nothing selected; its items are SelectionItems supporting Select/AddToSelection/
//     RemoveFromSelection and the container exposes CanSelectMultiple=true. (ListView, not ListBox — a
//     WinForms ListBox's UIA provider does not honor AddToSelection.)
//   - WindowPattern: a button ("btnOpenDialog") that opens a NON-modal child Form ("Controls Dialog")
//     via .Show() (not ShowDialog) so automation can drive it and close it (WindowPattern.Close) while
//     the parent stays usable.
//
// In WinForms UIA a control's .Name becomes its AutomationId, so each control's Name is set exactly to
// the id the test expects. Minimal and dependency-free (WinForms only).

using System.Windows.Forms;

namespace ControlsApp;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        var form = new Form
        {
            Text = "ControlsApp",
            Width = 520,
            Height = 420,
            StartPosition = FormStartPosition.CenterScreen,
        };

        // TreeView: one collapsed root with two children. AutomationId = treeMain.
        var tree = new TreeView
        {
            Name = "treeMain",
            Left = 12,
            Top = 12,
            Width = 220,
            Height = 320,
        };
        var root = new TreeNode("RootNode");
        root.Nodes.Add(new TreeNode("ChildA"));
        root.Nodes.Add(new TreeNode("ChildB"));
        tree.Nodes.Add(root);
        root.Collapse(); // ensure the root starts collapsed so an expand test has work to do

        // ListView (Details, MultiSelect): the canonical UIA multi-select container — its items expose
        // SelectionItemPattern with reliable Select/AddToSelection/RemoveFromSelection, and the container
        // exposes Selection with CanSelectMultiple=true. (A WinForms ListBox's UIA provider does NOT honor
        // AddToSelection, so it is unusable for this test.) AutomationId = listMulti.
        var list = new ListView
        {
            Name = "listMulti",
            View = View.Details,
            MultiSelect = true,
            FullRowSelect = true,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            Left = 248,
            Top = 12,
            Width = 240,
            Height = 320,
        };
        list.Columns.Add("Items", 200);
        foreach (var t in new[] { "Item 1", "Item 2", "Item 3", "Item 4", "Item 5" })
        {
            list.Items.Add(new ListViewItem(t));
        }

        // Button: opens a non-modal child window. AutomationId = btnOpenDialog.
        var openButton = new Button
        {
            Name = "btnOpenDialog",
            Text = "Open Dialog",
            Left = 12,
            Top = 344,
            Width = 220,
            Height = 28,
        };
        openButton.Click += (_, _) =>
        {
            var dialog = new Form
            {
                Text = "Controls Dialog",
                Width = 320,
                Height = 180,
                StartPosition = FormStartPosition.CenterParent,
            };
            dialog.Controls.Add(new Label
            {
                Text = "child dialog body",
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = System.Drawing.ContentAlignment.MiddleCenter,
            });
            // Non-modal: .Show() (not ShowDialog) so the parent stays usable and automation can drive
            // both windows; the child is a UIA Window supporting WindowPattern.Close.
            dialog.Show(form);
        };

        form.Controls.Add(tree);
        form.Controls.Add(list);
        form.Controls.Add(openButton);

        Application.Run(form);
    }
}

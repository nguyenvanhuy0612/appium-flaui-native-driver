// HangApp — a minimal UIA-visible WinForms window whose "Freeze" button blocks its own UI thread.
//
// Used by tests/e2e/11-hang-injection.e2e.spec.ts to inject a REAL frozen-UI condition and prove the
// driver's anti-hang contract (design §6): one op against the frozen window fails fast (bounded by
// flaui:operationTimeout) with a W3C `timeout`, while the Appium server + session survive.
//
// Mechanics: clicking "Freeze" runs Thread.Sleep on the UI thread. While the UI thread sleeps the
// window stops pumping its message loop, so the OS marks it "Not Responding" and ANY UIA cross-process
// property query against it (BoundingRectangle, Name, IsEnabled, find, ...) blocks until the thread
// wakes — the canonical hung-app case. The freeze duration is generous (default 60s) so the watchdog
// fires well before the app recovers; pass an arg to override (seconds).

using System.Windows.Forms;

namespace HangApp;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var freezeSeconds = 60;
        if (args.Length > 0 && int.TryParse(args[0], out var s) && s > 0) freezeSeconds = s;

        ApplicationConfiguration.Initialize();

        var form = new Form
        {
            Text = "HangApp",
            Width = 360,
            Height = 220,
            StartPosition = FormStartPosition.CenterScreen,
        };

        var status = new Label
        {
            // AutomationId so the test can read status OS-version-independently.
            Name = "StatusLabel",
            Text = "ready",
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 40,
            TextAlign = System.Drawing.ContentAlignment.MiddleCenter,
        };

        var freezeButton = new Button
        {
            // AutomationId = control Name in WinForms UIA; the test clicks this to inject the freeze.
            Name = "FreezeButton",
            Text = "Freeze",
            Dock = DockStyle.Fill,
        };
        freezeButton.Click += (_, _) =>
        {
            status.Text = "freezing";
            status.Refresh(); // flush the label paint BEFORE we wedge the thread
            // Block the UI thread: the message pump stops, the window goes "Not Responding", and any
            // cross-process UIA query against this window will hang until this returns.
            System.Threading.Thread.Sleep(freezeSeconds * 1000);
            status.Text = "thawed";
        };

        var panel = new Panel { Dock = DockStyle.Fill };
        panel.Controls.Add(freezeButton);
        form.Controls.Add(panel);
        form.Controls.Add(status);

        Application.Run(form);
    }
}

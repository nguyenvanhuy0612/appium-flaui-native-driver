using FlaUiSidecar;
using Xunit;
using static FlaUiSidecar.OpLogic;

/// <summary>
/// Session-teardown app-lifecycle decision (DELETE /session). Nova-parity semantics:
/// graceful teardown only CLOSES the root window (WindowPattern.Close, no wait) and NEVER kills the
/// process — a tray-resident app (e.g. a logged-in security agent) must survive with its in-memory
/// state intact. Kill is reserved for ms:forcequit. Attached sessions are never touched at all.
/// </summary>
public class TeardownAppActionTests
{
    [Fact]
    public void Launched_Default_ClosesWindow_NeverKills() =>
        Assert.Equal(TeardownAppAction.CloseWindow,
            DecideTeardownAppAction(attached: false, shouldCloseApp: true, forceQuit: false));

    [Fact]
    public void Launched_ForceQuit_Kills() =>
        Assert.Equal(TeardownAppAction.Kill,
            DecideTeardownAppAction(attached: false, shouldCloseApp: true, forceQuit: true));

    [Theory] // attached sessions are never closed or killed, whatever the other flags say
    [InlineData(true, false)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(false, true)]
    public void Attached_AlwaysNone(bool shouldCloseApp, bool forceQuit) =>
        Assert.Equal(TeardownAppAction.None,
            DecideTeardownAppAction(attached: true, shouldCloseApp: shouldCloseApp, forceQuit: forceQuit));

    [Theory] // shouldCloseApp=false wins over forcequit (same precedence as nova)
    [InlineData(false)]
    [InlineData(true)]
    public void ShouldCloseAppFalse_AlwaysNone(bool forceQuit) =>
        Assert.Equal(TeardownAppAction.None,
            DecideTeardownAppAction(attached: false, shouldCloseApp: false, forceQuit: forceQuit));
}

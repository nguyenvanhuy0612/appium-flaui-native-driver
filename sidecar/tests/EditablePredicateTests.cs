using System;
using FlaUiSidecar;
using Xunit;
using static FlaUiSidecar.OpLogic;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Unit tests for the Element Clear / value-replace editability predicate (<see cref="OpLogic.IsEditable"/>)
/// and its W3C error classification. Confirmed-broken bug #5: clear() on a Window element returned 200 by
/// falling back to destructive Ctrl+A/Delete; W3C §12.5.2 requires "invalid element state". Pure /
/// FlaUI-free.
/// </summary>
public class EditablePredicateTests
{
    // ── editable cases (must NOT throw / must clear) ───────────────────────────────────────────────
    [Fact]
    public void WritableValuePattern_IsEditable() =>
        Assert.True(IsEditable(hasWritableValuePattern: true, hasEditableTextPattern: false, "Edit"));

    [Fact]
    public void EditableTextPattern_IsEditable() =>
        // a focusable text control settable via keystrokes (read-only/absent ValuePattern but TextPattern)
        Assert.True(IsEditable(hasWritableValuePattern: false, hasEditableTextPattern: true, "Document"));

    [Theory]
    [InlineData("Edit")]
    [InlineData("Document")]
    [InlineData("ComboBox")]
    [InlineData("edit")]      // case-insensitive
    public void TextInputControlType_IsEditable_EvenWithBarePatterns(string controlType) =>
        // Notepad's Edit/Document and RichEdit must still clear even if they under-report patterns.
        Assert.True(IsEditable(hasWritableValuePattern: false, hasEditableTextPattern: false, controlType));

    // ── non-editable cases (must throw → "invalid element state") ──────────────────────────────────
    [Theory]
    [InlineData("Window")]
    [InlineData("Pane")]
    [InlineData("Button")]
    [InlineData(null)]
    public void NonTextControl_NoPatterns_IsNotEditable(string? controlType) =>
        Assert.False(IsEditable(hasWritableValuePattern: false, hasEditableTextPattern: false, controlType));

    // ── error classification: InvalidElementStateException → "invalid element state" ────────────────
    [Fact]
    public void ClassifyError_InvalidElementState_MapsToWireString()
    {
        var w3c = ClassifyError(new InvalidElementStateException("not editable"));
        Assert.Equal("invalid element state", w3c);
        Assert.Equal(W3C.InvalidElementState, w3c);
    }

    [Fact]
    public void InvalidElementState_IsDistinctFrom_InvalidArgument()
    {
        Assert.NotEqual(
            ClassifyError(new InvalidElementStateException("x")),
            ClassifyError(new InvalidArgumentException("y")));
    }
}

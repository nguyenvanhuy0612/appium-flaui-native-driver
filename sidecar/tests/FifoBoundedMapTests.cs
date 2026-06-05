using System.Collections.Generic;
using FlaUiSidecar;
using Xunit;

public class FifoBoundedMapTests
{
    [Fact]
    public void EvictsOldestFirst_InInsertionOrder()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 3, onEvict: v => evicted.Add(v));
        m.Set(1, 10);
        m.Set(2, 20);
        m.Set(3, 30);
        m.Set(4, 40); // over cap → evict oldest (key 1)

        Assert.Equal(new[] { 10 }, evicted);
        Assert.False(m.TryGet(1, out _));
        Assert.True(m.TryGet(2, out var v2)); Assert.Equal(20, v2);
        Assert.True(m.TryGet(4, out var v4)); Assert.Equal(40, v4);
        Assert.Equal(3, m.Count);
    }

    [Fact]
    public void AtCapBoundary_NoEviction()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 3, onEvict: v => evicted.Add(v));
        Assert.False(m.Set(1, 1));
        Assert.False(m.Set(2, 2));
        Assert.False(m.Set(3, 3)); // exactly at cap → still no eviction
        Assert.Empty(evicted);
        Assert.Equal(3, m.Count);
    }

    [Fact]
    public void ReturnValue_TrueOnlyWhenEvictionHappens()
    {
        var m = new FifoBoundedMap<int, int>(max: 2);
        Assert.False(m.Set(1, 1));
        Assert.False(m.Set(2, 2));
        Assert.True(m.Set(3, 3)); // evicts key 1
    }

    [Fact]
    public void ReregisterTouch_UpdatesValue_AndMovesToNewest()
    {
        var m = new FifoBoundedMap<int, string>(max: 2);
        m.Set(1, "a");
        m.Set(1, "b"); // update value + touch (no eviction, key 1 stays)
        Assert.Equal(1, m.Count);
        Assert.True(m.TryGet(1, out var v));
        Assert.Equal("b", v);
    }

    [Fact]
    public void ReregisterTouch_PreventsPrematureEvictionOfLiveEntry()
    {
        // The bug: a frequently-touched element kept its OLDEST slot and got evicted while still in use.
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 2, onEvict: v => evicted.Add(v));
        m.Set(1, 1);   // oldest
        m.Set(2, 2);
        m.Set(1, 1);   // touch key 1 → now newest; key 2 becomes oldest
        m.Set(3, 3);   // over cap → evict the now-oldest (key 2), NOT the touched live key 1

        Assert.Equal(new[] { 2 }, evicted);
        Assert.True(m.TryGet(1, out _));   // live entry survived
        Assert.False(m.TryGet(2, out _));
        Assert.True(m.TryGet(3, out _));
    }

    [Fact]
    public void OnEvict_FiresExactlyOncePerEviction()
    {
        var counts = new Dictionary<int, int>();
        var m = new FifoBoundedMap<int, int>(max: 2, onEvict: v =>
            counts[v] = counts.TryGetValue(v, out var c) ? c + 1 : 1);
        m.Set(1, 100);
        m.Set(2, 200);
        m.Set(3, 300); // evict 100
        m.Set(4, 400); // evict 200

        Assert.Equal(2, counts.Count);
        Assert.Equal(1, counts[100]);
        Assert.Equal(1, counts[200]);
    }

    [Fact]
    public void OnEvict_NotFiredOnReregisterUpdate()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 2, onEvict: v => evicted.Add(v));
        m.Set(1, 1);
        m.Set(1, 2); // update only — must NOT evict
        Assert.Empty(evicted);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void NonPositiveCap_DefaultsTo10000(int cap)
    {
        var m = new FifoBoundedMap<int, int>(max: cap);
        Assert.Equal(10_000, m.Capacity);
    }

    [Fact]
    public void OnEvict_ThatThrows_DoesNotCorruptMap()
    {
        var m = new FifoBoundedMap<int, int>(max: 1, onEvict: _ => throw new InvalidOperationException("boom"));
        m.Set(1, 1);
        m.Set(2, 2); // eviction callback throws but is swallowed
        Assert.False(m.TryGet(1, out _));
        Assert.True(m.TryGet(2, out _));
        Assert.Equal(1, m.Count);
    }

    [Fact]
    public void TryGet_MissingKey_ReturnsFalseAndDefault()
    {
        var m = new FifoBoundedMap<int, string>(max: 2);
        Assert.False(m.TryGet(99, out var v));
        Assert.Null(v);
    }
}

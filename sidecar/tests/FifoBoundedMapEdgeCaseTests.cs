using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using FlaUiSidecar;
using Xunit;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Additional edge-case coverage for <see cref="FifoBoundedMap{TKey,TValue}"/>: cap=1, re-touch ordering
/// under churn, eviction-callback exceptions mid-batch, null-value handling, and thread-safety smoke.
/// Documents CURRENT behavior; FlaUI-free.
/// </summary>
public class FifoBoundedMapEdgeCaseTests
{
    // ── cap = 1 ────────────────────────────────────────────────────────────────────────────────────
    [Fact]
    public void CapOne_EachNewKeyEvictsThePrevious()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 1, onEvict: v => evicted.Add(v));
        Assert.False(m.Set(1, 10));   // first insert, nothing to evict
        Assert.True(m.Set(2, 20));    // evicts key 1
        Assert.True(m.Set(3, 30));    // evicts key 2

        Assert.Equal(new[] { 10, 20 }, evicted);
        Assert.Equal(1, m.Count);
        Assert.False(m.TryGet(1, out _));
        Assert.False(m.TryGet(2, out _));
        Assert.True(m.TryGet(3, out var v)); Assert.Equal(30, v);
    }

    [Fact]
    public void CapOne_ReTouchSameKey_NeverEvicts()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 1, onEvict: v => evicted.Add(v));
        m.Set(1, 1);
        Assert.False(m.Set(1, 2));    // update only
        Assert.False(m.Set(1, 3));
        Assert.Empty(evicted);
        Assert.True(m.TryGet(1, out var v)); Assert.Equal(3, v);
    }

    // ── cap <= 0 falls back to default 10000 (a huge, non-evicting practical cap) ───────────────────
    [Fact]
    public void DefaultedCap_DoesNotEvictForModestVolume()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 0, onEvict: v => evicted.Add(v)); // → 10000
        for (var i = 0; i < 5000; i++) m.Set(i, i);
        Assert.Empty(evicted);
        Assert.Equal(5000, m.Count);
    }

    [Fact]
    public void DefaultedCap_EvictsExactlyOnceAt10001()
    {
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 0, onEvict: v => evicted.Add(v)); // → 10000
        for (var i = 0; i < 10_000; i++) m.Set(i, i);
        Assert.Empty(evicted);
        Assert.True(m.Set(10_000, 10_000)); // the 10001st distinct key evicts key 0
        Assert.Equal(new[] { 0 }, evicted);
        Assert.Equal(10_000, m.Count);
    }

    // ── re-touch ordering under churn ──────────────────────────────────────────────────────────────
    [Fact]
    public void ReTouchUnderChurn_SurvivorIsTheRepeatedlyTouchedKey()
    {
        // Keep touching key 0 while a stream of fresh keys churns through a cap-3 map.
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 3, onEvict: v => evicted.Add(v));
        m.Set(0, 0);
        for (var i = 1; i <= 20; i++)
        {
            m.Set(i, i);
            m.Set(0, 0); // touch the live key every round → it must never be evicted
        }
        Assert.True(m.TryGet(0, out _), "the repeatedly-touched key must survive all churn");
        Assert.DoesNotContain(0, evicted);
        Assert.Equal(3, m.Count);
    }

    [Fact]
    public void Touch_OnNonOldestKey_DoesNotChangeWhichIsOldest()
    {
        // keys 1,2,3 (cap 3). Touch the MIDDLE key 2 → order becomes 1(oldest),3,2(newest).
        var evicted = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 3, onEvict: v => evicted.Add(v));
        m.Set(1, 1); m.Set(2, 2); m.Set(3, 3);
        m.Set(2, 22);            // touch middle
        m.Set(4, 4);             // over cap → evict the oldest, which is still key 1

        Assert.Equal(new[] { 1 }, evicted);
        Assert.True(m.TryGet(2, out var v2)); Assert.Equal(22, v2); // touched value updated + survived
        Assert.True(m.TryGet(3, out _));
        Assert.True(m.TryGet(4, out _));
    }

    // ── eviction callback throwing mid-batch ───────────────────────────────────────────────────────
    [Fact]
    public void OnEvict_ThrowingOnFirstOfBatch_StillReportsEvictionAndKeepsMapConsistent()
    {
        // A single Set can only evict one entry at a time (insert path evicts while Count > max, and each
        // insert adds exactly one). Verify a throwing callback does not leave a half-evicted map.
        var seen = new List<int>();
        var m = new FifoBoundedMap<int, int>(max: 2, onEvict: v =>
        {
            seen.Add(v);
            throw new InvalidOperationException("callback boom");
        });
        m.Set(1, 1);
        m.Set(2, 2);
        Assert.True(m.Set(3, 3)); // evicts key 1; callback throws but is swallowed
        Assert.Equal(new[] { 1 }, seen);
        Assert.False(m.TryGet(1, out _));
        Assert.True(m.TryGet(2, out _));
        Assert.True(m.TryGet(3, out _));
        Assert.Equal(2, m.Count);
    }

    [Fact]
    public void NoOnEvict_EvictionStillHappensSilently()
    {
        var m = new FifoBoundedMap<int, int>(max: 2); // no callback
        m.Set(1, 1); m.Set(2, 2);
        Assert.True(m.Set(3, 3)); // returns true even with no callback
        Assert.False(m.TryGet(1, out _));
        Assert.Equal(2, m.Count);
    }

    // ── null / reference values ────────────────────────────────────────────────────────────────────
    [Fact]
    public void NullValue_RoundTrips_AndEvictionPassesNullToCallback()
    {
        var evicted = new List<string?>();
        var m = new FifoBoundedMap<int, string?>(max: 1, onEvict: v => evicted.Add(v));
        m.Set(1, null);
        Assert.True(m.TryGet(1, out var v));
        Assert.Null(v);
        m.Set(2, "x"); // evicts key 1 whose value was null
        Assert.Equal(new string?[] { null }, evicted);
    }

    [Fact]
    public void StringKeys_AreCaseSensitive_DistinctEntries()
    {
        var m = new FifoBoundedMap<string, int>(max: 5);
        m.Set("Key", 1);
        m.Set("key", 2); // different key under the default ordinal comparer
        Assert.Equal(2, m.Count);
        Assert.True(m.TryGet("Key", out var a)); Assert.Equal(1, a);
        Assert.True(m.TryGet("key", out var b)); Assert.Equal(2, b);
    }

    // ── Capacity property reflects the effective cap ────────────────────────────────────────────────
    [Theory]
    [InlineData(1, 1)]
    [InlineData(7, 7)]
    [InlineData(0, 10_000)]
    [InlineData(-3, 10_000)]
    public void Capacity_ReflectsEffectiveCap(int requested, int effective) =>
        Assert.Equal(effective, new FifoBoundedMap<int, int>(max: requested).Capacity);

    // ── thread-safety smoke (deterministic invariants, not timing) ─────────────────────────────────
    [Fact]
    public async Task ConcurrentSets_MapStaysWithinCap_AndCountIsConsistent()
    {
        var m = new FifoBoundedMap<int, int>(max: 100);
        var tasks = Enumerable.Range(0, 8).Select(t => Task.Run(() =>
        {
            for (var i = 0; i < 2000; i++) m.Set((t * 2000) + i, i);
        })).ToArray();
        await Task.WhenAll(tasks);

        // Cap is the hard invariant under concurrency; Count must never exceed it.
        Assert.True(m.Count <= 100, $"Count {m.Count} must never exceed cap 100");
        Assert.True(m.Count > 0);
    }
}

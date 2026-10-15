// Verification targets strings, directives, docs and modern C# expressions.
#nullable enable
#pragma warning disable CS1591
using System;
using System.Collections.Generic;
using System.Linq;

namespace SafetyChecks;

#region Models
/// <summary>Retains the original XML documentation.</summary>
/// <remarks>Retains the second XML documentation line.</remarks>
[Serializable]
public record Entry(string Name, int Count);
#endregion

public static class Examples
{
    public static string Describe(string name)
    {
        var verbatim = @"verbatim starts
verbatim continues with ""quotes""
verbatim ends";
        var interpolatedVerbatim = $@"interpolated verbatim starts {name}
interpolated verbatim continues
interpolated verbatim ends";
        var raw = """
            raw starts
            raw continues with "quotes" and // text
            raw ends
            """;
        var interpolatedRaw = $"""
            interpolated raw starts {name}
            interpolated raw continues
            interpolated raw ends
            """;
        return string.Join("|", verbatim, interpolatedVerbatim, raw, interpolatedRaw);
    }

    public static int Calculate(IEnumerable<Entry> entries)
    {
#if DEBUG
        const int multiplier = 2;
#else
        const int multiplier = 1;
#endif
        var defaults = new List<Entry>
        {
            new Entry("Ada", 2),
            // Keep the collection's second element on its own line.
            new Entry("Grace", 3)
        };
        var chosen = new Entry("Linus", 4)
        {
            // Override the positional record's generated property.
            Count = 5
        };
        var counts = new[]
        {
            1,
            // Keep the array's second element on its own line.
            2
        };
        var query = from entry in entries.Concat(defaults)
                    where entry.Count > 0
                    orderby entry.Name
                    select entry.Count;
        Func<int, int> twice = value => value * 2;
        var total = query.Sum() + chosen.Count + counts.Length;
        return total switch
        {
            0 => 0,
            > 10 => twice(total),
            _ => total * multiplier
        };
    }
}

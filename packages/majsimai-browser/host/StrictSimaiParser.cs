using System.Globalization;
using System.Numerics;
using MajSimai;

namespace MajSimaiBrowser;

internal static class StrictSimaiParser
{
    internal const int MaxSourceLengthUtf16 = 2_000_000;
    private const int MaxLines = 50_000;
    private const int MaxTokenLength = 4_096;
    private const int MaxCellLength = 16_384;
    private const int MaxNotesPerChart = 100_000;
    private const int MaxSlideSegmentsPerPath = 64;
    private const double UpstreamTimingToleranceSeconds = 1e-6;

    internal static ParserResult Parse(string source)
    {
        var result = new ParserResult { SourceLengthUtf16 = source.Length };
        var diagnostics = new List<DiagnosticDto>();
        var fields = new List<SourceFieldDto>();

        if (source.Length > MaxSourceLengthUtf16)
        {
            diagnostics.Add(Diagnostic("input-too-large", $"Input exceeds {MaxSourceLengthUtf16} UTF-16 code units.", new(0, source.Length)));
            result.GlobalEditable = false;
            result.Diagnostics = diagnostics.ToArray();
            return result;
        }

        var lines = GetLines(source);
        if (lines.Count > MaxLines)
        {
            diagnostics.Add(Diagnostic("too-many-lines", $"Input exceeds {MaxLines} lines.", new(0, source.Length)));
            result.GlobalEditable = false;
            result.Diagnostics = diagnostics.ToArray();
            return result;
        }

        var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
        var firstSeen = new HashSet<string>(StringComparer.Ordinal);
        var chartBlocks = new Dictionary<int, ChartBlock>();
        var levels = new Dictionary<int, string>();
        var designers = new Dictionary<int, string>();
        string finalDesigner = "";
        var firstSeconds = 0d;

        for (var lineIndex = 0; lineIndex < lines.Count; lineIndex++)
        {
            var line = lines[lineIndex];
            var bounds = TrimBounds(source, line.Start, line.ContentEnd, lineIndex == 0);
            if (bounds.Start == bounds.End || source[bounds.Start] != '&')
                continue;

            var equals = source.IndexOf('=', bounds.Start, bounds.End - bounds.Start);
            if (equals < 0)
            {
                diagnostics.Add(Diagnostic("invalid-metadata-field", "Metadata fields must contain '='.", new(bounds.Start, bounds.End)));
                result.GlobalEditable = false;
                continue;
            }

            var name = source[(bounds.Start + 1)..equals];
            if (name.Length == 0)
            {
                diagnostics.Add(Diagnostic("invalid-metadata-field", "Metadata field name is empty.", new(bounds.Start, equals + 1)));
                result.GlobalEditable = false;
                continue;
            }

            var difficulty = ParseDifficultyName(name, "inote_");
            var blockLastLine = lineIndex;
            if (name.StartsWith("inote_", StringComparison.Ordinal) && difficulty is not (>= 1 and <= 7))
            {
                diagnostics.Add(Diagnostic("unsupported-difficulty-field", "Only inote_1 through inote_7 are understood; the document is read-only.", new(line.Start, line.NextStart)));
                result.GlobalEditable = false;
            }
            if (difficulty is >= 1 and <= 7)
            {
                for (var candidate = lineIndex + 1; candidate < lines.Count; candidate++)
                {
                    var next = lines[candidate];
                    var nextBounds = TrimBounds(source, next.Start, next.ContentEnd, false);
                    if (nextBounds.Start < nextBounds.End && source[nextBounds.Start] == '&')
                        break;
                    blockLastLine = candidate;
                }
            }

            var blockEnd = lines[blockLastLine].NextStart;
            var valueStart = equals + 1;
            var valueRange = new SourceRangeDto(valueStart, blockEnd);
            var field = new SourceFieldDto
            {
                Name = name,
                Range = new(line.Start, blockEnd),
                ValueRange = valueRange,
                RawValue = source[valueStart..blockEnd]
            };
            fields.Add(field);

            if (IsKnownField(name))
            {
                occurrences.TryGetValue(name, out var count);
                count++;
                occurrences[name] = count;
                if (count > 1)
                {
                    diagnostics.Add(Diagnostic("duplicate-known-field", $"Known metadata field '&{name}' occurs more than once; the document is read-only.", field.Range));
                    result.GlobalEditable = false;
                }
            }

            if (difficulty is >= 1 and <= 7)
            {
                var difficultyIndex = difficulty.Value;
                var canonical = BuildChartText(source, lines, lineIndex, blockLastLine, equals + 1, bounds.End);
                var block = new ChartBlock(difficultyIndex, field, canonical.Text, canonical.SourceOffsets, canonical.SourceRange);
                chartBlocks[difficultyIndex] = block;
                lineIndex = blockLastLine;
                continue;
            }

            var valueEnd = line.ContentEnd;
            var rawValue = source[valueStart..valueEnd].Trim();
            var levelIndex = ParseDifficultyName(name, "lv_");
            var designerIndex = ParseDifficultyName(name, "des_");
            if (levelIndex is >= 1 and <= 7 && !levels.ContainsKey(levelIndex.Value))
                levels[levelIndex.Value] = rawValue;
            if (designerIndex is >= 1 and <= 7 && !designers.ContainsKey(designerIndex.Value))
                designers[designerIndex.Value] = rawValue;
            if (name == "des" && finalDesigner.Length == 0)
                finalDesigner = rawValue;

            if (name == "first" && firstSeen.Add(name))
            {
                if (double.TryParse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedFirst) && double.IsFinite(parsedFirst))
                    firstSeconds = parsedFirst;
                else
                {
                    diagnostics.Add(Diagnostic("invalid-first", "The '&first' value is not a finite number; global editing is disabled.", field.ValueRange));
                    result.GlobalEditable = false;
                }
            }
        }

        if (finalDesigner.Length == 0)
        {
            for (var i = 1; i <= 7; i++)
            {
                if (designers.TryGetValue(i, out var designer) && designer.Length != 0)
                    finalDesigner = designer;
            }
        }

        result.Fields = fields.ToArray();
        result.FirstSeconds = firstSeconds;
        var charts = new List<ParserChartDto>(chartBlocks.Count);
        foreach (var pair in chartBlocks.OrderBy(pair => pair.Key))
        {
            var difficulty = pair.Key;
            var block = pair.Value;
            var chart = ParseChart(block, levels.GetValueOrDefault(difficulty, ""), designers.GetValueOrDefault(difficulty, ""));
            if (!result.GlobalEditable)
                chart.Editable = false;
            charts.Add(chart);
            diagnostics.AddRange(chart.Diagnostics);
        }

        result.Charts = charts.ToArray();
        result.Diagnostics = diagnostics.ToArray();
        return result;
    }

    private static ParserChartDto ParseChart(ChartBlock block, string level, string designer)
    {
        var diagnostics = new List<DiagnosticDto>();
        var notes = new List<ParserNoteDto>();
        var bpms = new List<BpmEventDto>();
        var source = block.Text;
        var terminalEnd = FindTerminalE(source);
        var parseEnd = terminalEnd >= 0 ? terminalEnd : source.Length;
        var currentBeat = new BigRational(BigInteger.Zero, BigInteger.One);
        var beatStep = new BigRational(new BigInteger(1), new BigInteger(1));
        var bpm = 0d;
        var seconds = 0d;
        var cellHasNotes = false;
        var segmentStart = 0;
        var noteOrder = 0;
        var editable = true;
        var hasSlideSyntax = false;
        var expandedNoteCount = 0;
        var upstreamExpected = new List<UpstreamNoteExpectation>();

        void AddChartDiagnostic(string code, string message, int start, int end)
        {
            diagnostics.Add(Diagnostic(code, message, block.MapRange(start, end) ?? block.SourceRange, block.Difficulty));
            editable = false;
        }

        for (var i = 0; i < parseEnd;)
        {
            var current = source[i];
            if (current == ',')
            {
                ParseSegment(segmentStart, i);
                segmentStart = i + 1;
                if (!(bpm > 0 && double.IsFinite(bpm)))
                {
                    AddChartDiagnostic("invalid-bpm", "A positive finite BPM must be declared before advancing the chart.", i, i + 1);
                }
                else
                {
                    var stepBeats = beatStep.ToDouble();
                    var stepSeconds = 60d / bpm * stepBeats;
                    if (!double.IsFinite(stepSeconds) || stepSeconds < 0)
                        AddChartDiagnostic("invalid-timing", "The chart timing step is not finite and non-negative.", i, i + 1);
                    else
                    {
                        seconds += stepSeconds;
                        var nextBeat = currentBeat + beatStep;
                        if (nextBeat.IsSerializable)
                            currentBeat = nextBeat;
                        else
                            AddChartDiagnostic("beat-out-of-range", "Beat position exceeds the exact integer range shared with JavaScript.", i, i + 1);
                    }
                }
                cellHasNotes = false;
                i++;
                continue;
            }

            if (current == '(')
            {
                ParseSegment(segmentStart, i);
                var close = source.IndexOf(')', i + 1, parseEnd - i - 1);
                if (close < 0)
                {
                    AddChartDiagnostic("unclosed-bpm", "BPM declaration is missing ')'.", i, parseEnd);
                    break;
                }
                if (cellHasNotes)
                    AddChartDiagnostic("timing-command-after-note", "A BPM change after notes in the same comma cell is not editable yet.", i, close + 1);
                var bpmText = source[(i + 1)..close].Trim();
                if (!TryFiniteDouble(bpmText, out bpm) || bpm <= 0 || bpm > float.MaxValue)
                {
                    AddChartDiagnostic("invalid-bpm", "BPM must be a positive finite number.", i + 1, close);
                    bpm = 0;
                }
                else
                {
                    if (!currentBeat.IsSerializable)
                    {
                        AddChartDiagnostic("beat-out-of-range", "BPM position exceeds the exact integer range shared with JavaScript.", i, close + 1);
                        i = close + 1;
                        segmentStart = i;
                        continue;
                    }
                    bpms.Add(new BpmEventDto
                    {
                        Beat = currentBeat.ToDto(),
                        Bpm = bpm,
                        SourceRange = block.MapRange(i, close + 1)
                    });
                }
                i = close + 1;
                segmentStart = i;
                continue;
            }

            if (current == '{')
            {
                ParseSegment(segmentStart, i);
                var close = source.IndexOf('}', i + 1, parseEnd - i - 1);
                if (close < 0)
                {
                    AddChartDiagnostic("unclosed-subdivision", "Beat subdivision is missing '}'.", i, parseEnd);
                    break;
                }
                if (cellHasNotes)
                    AddChartDiagnostic("timing-command-after-note", "A beat subdivision change after notes in the same comma cell is not editable yet.", i, close + 1);
                var value = source[(i + 1)..close].Trim();
                if (value.StartsWith('#'))
                {
                    var intervalText = value[1..];
                    if (!TryDecimalRational(intervalText, out var interval) || interval.Numerator <= 0 || bpm <= 0)
                    {
                        AddChartDiagnostic("invalid-subdivision", "Absolute-time subdivisions need a positive finite interval and a known positive BPM.", i + 1, close);
                    }
                    else
                    {
                        if (TryDecimalRational(bpm.ToString("R", CultureInfo.InvariantCulture), out var bpmRational))
                        {
                            var candidate = interval * bpmRational / new BigRational(60, 1);
                            if (candidate.IsSerializable)
                                beatStep = candidate;
                            else
                                AddChartDiagnostic("subdivision-out-of-range", "Beat subdivision exceeds the exact integer range shared with JavaScript.", i + 1, close);
                        }
                        else
                        {
                            AddChartDiagnostic("subdivision-out-of-range", "BPM cannot be represented as an exact bounded beat fraction.", i + 1, close);
                        }
                    }
                }
                else if (TryDecimalRational(value, out var subdivision) && subdivision.Numerator > 0)
                {
                    var candidate = new BigRational(4, 1) / subdivision;
                    if (candidate.IsSerializable)
                        beatStep = candidate;
                    else
                        AddChartDiagnostic("subdivision-out-of-range", "Beat subdivision exceeds the exact integer range shared with JavaScript.", i + 1, close);
                }
                else
                {
                    AddChartDiagnostic("invalid-subdivision", "Beat subdivision must be a positive finite number.", i + 1, close);
                }
                i = close + 1;
                segmentStart = i;
                continue;
            }

            if (current == '<' && !IsSlideAngleCommand(source, segmentStart, i, parseEnd))
            {
                ParseSegment(segmentStart, i);
                var close = source.IndexOf('>', i + 1, parseEnd - i - 1);
                var end = close < 0 ? parseEnd : close + 1;
                AddChartDiagnostic("unsupported-state-command", "HS/SV state commands are preserved as source and make this difficulty read-only.", i, end);
                i = end;
                segmentStart = i;
                continue;
            }

            if (current == '|')
            {
                ParseSegment(segmentStart, i);
                var end = source.IndexOf('\n', i, parseEnd - i);
                if (end < 0) end = parseEnd;
                AddChartDiagnostic("unsupported-chart-comment", "Chart comments and signature commands are preserved as source and make this difficulty read-only.", i, end);
                i = end;
                segmentStart = i;
                continue;
            }

            i++;
        }

        ParseSegment(segmentStart, parseEnd);
        if (terminalEnd >= 0)
        {
            var markerRange = block.MapRange(terminalEnd, terminalEnd + 1);
            if (markerRange is not null)
            {
                // The E marker is structural and is not a note consumed by this MajSimai revision.
            }
        }
        else
        {
            var first = segmentStart;
            while (first < parseEnd && char.IsWhiteSpace(source[first])) first++;
            if (first < parseEnd)
                AddChartDiagnostic("trailing-content", "A note cell must end with ',' before end of input.", first, parseEnd);
            AddChartDiagnostic("missing-terminal-marker", "A strict editable chart must end with a standalone E marker.", Math.Max(0, parseEnd - 1), parseEnd);
        }

        if (upstreamExpected.Count != 0)
        {
            try
            {
                var upstream = SimaiParser.ParseChart(source.AsSpan());
                var upstreamNotes = upstream.NoteTimings.ToArray()
                    .SelectMany(point => point.Notes.Select(note => (point.Timing, Note: note)))
                    .ToArray();
                if (upstreamNotes.Length != upstreamExpected.Count)
                {
                    diagnostics.Add(Diagnostic("upstream-result-mismatch", "Strict source notes and the pinned MajSimai result have different event counts.", block.SourceRange, block.Difficulty));
                    editable = false;
                }
                else
                {
                    for (var index = 0; index < upstreamExpected.Count; index++)
                    {
                        var expected = upstreamExpected[index];
                        var actual = upstreamNotes[index].Note;
                        var type = expected.Kind switch
                        {
                            "tap" => SimaiNoteType.Tap,
                            "hold" => SimaiNoteType.Hold,
                            "touch" => SimaiNoteType.Touch,
                            "touchHold" => SimaiNoteType.TouchHold,
                            "slide" => SimaiNoteType.Slide,
                            _ => (SimaiNoteType)(-1)
                        };
                        var expectedPosition = expected.TouchArea == "C" ? 8 : expected.Position;
                        var actualTiming = upstreamNotes[index].Timing;
                        var durationMatches = expected.Slide is not null
                            ? Math.Abs(actual.SlideTime - expected.MoveSeconds) <= 1e-9
                            : Math.Abs(actual.HoldTime - expected.DurationSeconds) <= 1e-9;
                        var slideMatches = expected.Slide is null
                            || (Math.Abs(actual.SlideStartTime - expected.MoveStartSeconds) <= UpstreamTimingToleranceSeconds
                                && actual.IsSlideBreak == expected.Slide.SlideBreak
                                && actual.IsTapHeadSlide == (expected.Slide.Head == "tap")
                                && actual.IsSlideNoHead == (expected.Slide.Head == "none"));
                        if (actual.Type != type || actual.StartPosition != expectedPosition
                            || (expected.TouchArea is not null && actual.TouchArea != expected.TouchArea[0])
                            || actual.IsBreak != expected.Modifiers.Break || actual.IsEx != expected.Modifiers.Ex
                            || (expected.Kind is "touch" or "touchHold" && actual.IsHanabi != expected.Firework)
                            || actual.IsForceStar != expected.ForceStar || actual.IsFakeRotate != expected.FakeRotate
                            || !durationMatches || !slideMatches
                            || Math.Abs(actualTiming - expected.StartSeconds) > UpstreamTimingToleranceSeconds)
                        {
                            diagnostics.Add(Diagnostic("upstream-result-mismatch", "Strict source note or pinned MajSimai semantics disagree; note and slide start times allow 1e-6 seconds and durations allow 1e-9 seconds.", expected.SourceRange, block.Difficulty));
                            editable = false;
                        }
                    }
                }
            }
            catch (Exception exception)
            {
                diagnostics.Add(Diagnostic("upstream-parse-error", $"Pinned MajSimai could not parse this chart: {exception.Message}", block.SourceRange, block.Difficulty));
                editable = false;
            }
        }

        if (hasSlideSyntax)
        {
            diagnostics.Add(Diagnostic("slide-validation-pending", "Slide runtime behavior in the target player has not been validated.", block.SourceRange, block.Difficulty, "warning"));
        }

        return new ParserChartDto
        {
            Difficulty = block.Difficulty,
            Level = level,
            Designer = designer,
            Editable = editable,
            FieldRange = block.Field.Range,
            SourceRange = block.SourceRange,
            EndBeat = currentBeat.IsSerializable ? currentBeat.ToDto() : new RationalDto(0, 1),
            Notes = notes.ToArray(),
            Bpms = bpms.ToArray(),
            Diagnostics = diagnostics.ToArray()
        };

        void ParseSegment(int start, int end)
        {
            if (start >= end) return;

            var nonWhitespace = new List<int>();
            for (var offset = start; offset < end; offset++)
            {
                if (!char.IsWhiteSpace(source[offset]))
                    nonWhitespace.Add(offset);
            }
            if (nonWhitespace.Count == 0) return;
            if (nonWhitespace.Count > MaxCellLength)
            {
                AddChartDiagnostic("cell-too-large", $"A comma cell exceeds {MaxCellLength} non-whitespace UTF-16 code units.", nonWhitespace[0], nonWhitespace[^1] + 1);
                return;
            }

            var first = nonWhitespace[0];
            if (nonWhitespace.Count == 1 && source[first] == 'E' && terminalEnd == first)
                return;

            cellHasNotes = true;
            var componentStart = 0;
            for (var cursor = 0; cursor <= nonWhitespace.Count; cursor++)
            {
                var isEnd = cursor == nonWhitespace.Count;
                if (!isEnd && source[nonWhitespace[cursor]] != '/') continue;
                if (cursor == componentStart)
                {
                    var at = isEnd ? nonWhitespace[^1] : nonWhitespace[cursor];
                    AddChartDiagnostic("empty-note", "Empty note component around '/'.", at, Math.Min(at + 1, end));
                }
                else
                {
                    var offsets = nonWhitespace.GetRange(componentStart, cursor - componentStart);
                    ParseComponent(offsets);
                }
                componentStart = cursor + 1;
            }
        }

        void ParseComponent(List<int> offsets)
        {
            if (offsets.Count > MaxTokenLength)
            {
                AddChartDiagnostic("note-too-large", $"A note token exceeds {MaxTokenLength} UTF-16 code units.", offsets[0], offsets[^1] + 1);
                return;
            }

            var token = new string(offsets.Select(offset => source[offset]).ToArray());
            if (token.Length == 2 && IsLane(token[0]) && IsLane(token[1]))
            {
                for (var expansion = 0; expansion < 2; expansion++)
                {
                    var offset = offsets[expansion];
                    AddNote(token[expansion].ToString(), [offset], expansion);
                }
                return;
            }

            AddNote(token, offsets, 0);
        }

        void AddNote(string token, List<int> offsets, int expansionIndex)
        {
            var range = block.MapRange(offsets[0], offsets[^1] + 1);
            if (range is null) return;
            if (ContainsSlideCommand(token))
            {
                hasSlideSyntax = true;
                if (!TryReadStrictSlide(token, out var slide, out var unsupportedFeature, out var slideErrorCode, out var slideErrorMessage, out var slideErrorStart, out var slideErrorEnd))
                {
                    var diagnosticRange = slideErrorStart >= 0 && slideErrorEnd > slideErrorStart
                        ? block.MapRange(offsets[Math.Min(slideErrorStart, offsets.Count - 1)], offsets[Math.Min(slideErrorEnd - 1, offsets.Count - 1)] + 1) ?? range
                        : range;
                    diagnostics.Add(Diagnostic(slideErrorCode, slideErrorMessage, diagnosticRange, block.Difficulty));
                    editable = false;
                    return;
                }

                if (expandedNoteCount + slide.SegmentCount > MaxNotesPerChart)
                {
                    diagnostics.Add(Diagnostic("too-many-notes", $"A difficulty exceeds the {MaxNotesPerChart} upstream note/segment limit.", range, block.Difficulty));
                    editable = false;
                    return;
                }
                expandedNoteCount += slide.SegmentCount;

                if (!(bpm > 0 && double.IsFinite(bpm)))
                {
                    diagnostics.Add(Diagnostic("invalid-bpm", "A positive finite BPM must be declared before a note.", range, block.Difficulty));
                    editable = false;
                    return;
                }
                if (!currentBeat.IsSerializable)
                {
                    diagnostics.Add(Diagnostic("beat-out-of-range", "Note beat exceeds the exact integer range shared with JavaScript.", range, block.Difficulty));
                    editable = false;
                    return;
                }

                var branchCount = slide.Dto.AdditionalPaths.Length + 1;
                if (upstreamExpected.Count + branchCount > MaxNotesPerChart)
                {
                    diagnostics.Add(Diagnostic("too-many-notes", $"A difficulty exceeds {MaxNotesPerChart} upstream note events.", range, block.Difficulty));
                    editable = false;
                    return;
                }
                var parsedSlides = SimaiNoteParser.GetNotes(seconds, bpm, token);
                if (parsedSlides.Length != branchCount)
                {
                    diagnostics.Add(Diagnostic("unsupported-slide-result", "MajSimai returned a different number of events than the shared-head paths.", range, block.Difficulty));
                    editable = false;
                    return;
                }
                if (notes.Count >= MaxNotesPerChart)
                {
                    diagnostics.Add(Diagnostic("too-many-notes", $"A difficulty exceeds {MaxNotesPerChart} notes.", range, block.Difficulty));
                    editable = false;
                    return;
                }

                var expectedBranches = new List<UpstreamNoteExpectation>(branchCount);
                var maxDurationSeconds = 0d;
                for (var index = 0; index < branchCount; index++)
                {
                    var path = index == 0
                        ? new SlidePathDto
                        {
                            Command = slide.Dto.Command,
                            EndPosition = slide.Dto.EndPosition,
                            SlideBreak = slide.Dto.SlideBreak,
                            Wait = slide.Dto.Wait,
                            Move = slide.Dto.Move,
                            Continuations = slide.Dto.Continuations
                        }
                        : slide.Dto.AdditionalPaths[index - 1];
                    if (!TryGetDurationSeconds(path.Wait, bpm, out var waitSeconds)
                        || !TryGetDurationSeconds(path.Move, bpm, out var moveSeconds))
                    {
                        diagnostics.Add(Diagnostic("invalid-slide-duration", "Every slide path wait and move must be finite and non-negative.", range, block.Difficulty));
                        editable = false;
                        return;
                    }
                    var branchDurationSeconds = waitSeconds + moveSeconds;
                    if (!double.IsFinite(branchDurationSeconds))
                    {
                        diagnostics.Add(Diagnostic("invalid-slide-duration", "Every slide path wait and move must have a finite sum.", range, block.Difficulty));
                        editable = false;
                        return;
                    }
                    maxDurationSeconds = Math.Max(maxDurationSeconds, branchDurationSeconds);

                    var branchHead = index == 0 ? slide.Dto.Head : "none";
                    var branchModifiers = index == 0 ? slide.Modifiers : new NoteModifiersDto();
                    var branchForceStar = index == 0 && slide.ForceStar;
                    var branchFakeRotate = index == 0 && slide.FakeRotate;
                    var branchSlide = new SlideDto
                    {
                        Command = path.Command,
                        EndPosition = path.EndPosition,
                        Head = branchHead,
                        SlideBreak = path.SlideBreak,
                        Wait = path.Wait,
                        Move = path.Move,
                        Continuations = path.Continuations
                    };
                    var expectation = new UpstreamNoteExpectation(
                        "slide", slide.StartPosition, null, seconds, branchDurationSeconds,
                        seconds + waitSeconds, moveSeconds, branchSlide, branchModifiers, false,
                        branchForceStar, branchFakeRotate, range);
                    if (!MatchesSlideEvent(parsedSlides[index], expectation))
                    {
                        diagnostics.Add(Diagnostic("unsupported-slide-result", "MajSimai rejected or interpreted one of the shared-head slide paths differently.", range, block.Difficulty));
                        editable = false;
                        return;
                    }
                    expectedBranches.Add(expectation);
                }

                upstreamExpected.AddRange(expectedBranches);

                if (unsupportedFeature)
                {
                    diagnostics.Add(Diagnostic("unsupported-slide-feature", "This slide uses a source modifier outside the editable slide DTO; the source is preserved and no slide note is emitted.", range, block.Difficulty, "warning"));
                    editable = false;
                    return;
                }

                var note = new ParserNoteDto
                {
                    Id = $"{block.Difficulty}:{range.Start}:{expansionIndex}",
                    Kind = "slide",
                    Beat = currentBeat.ToDto(),
                    Position = slide.StartPosition,
                    Order = noteOrder++,
                    SourceRange = range,
                    StartSeconds = seconds,
                    DurationSeconds = maxDurationSeconds,
                    MoveStartSeconds = expectedBranches[0].MoveStartSeconds,
                    Slide = slide.Dto,
                    Modifiers = slide.Modifiers
                };
                notes.Add(note);
                return;
            }

            if (!TryReadStrictNote(token, out var position, out var touchArea, out var isTouch, out var isHold, out var firework, out var forceStar, out var modifiers, out var duration, out var errorCode, out var errorMessage, out var errorStart, out var errorEnd))
            {
                var diagnosticRange = errorStart >= 0 && errorEnd >= errorStart
                    ? block.MapRange(offsets[Math.Min(errorStart, offsets.Count - 1)], offsets[Math.Min(errorEnd - 1, offsets.Count - 1)] + 1) ?? range
                    : range;
                diagnostics.Add(Diagnostic(errorCode, errorMessage, diagnosticRange, block.Difficulty));
                editable = false;
                return;
            }

            if (!(bpm > 0 && double.IsFinite(bpm)))
            {
                diagnostics.Add(Diagnostic("invalid-bpm", "A positive finite BPM must be declared before a note.", range, block.Difficulty));
                editable = false;
                return;
            }
            if (!currentBeat.IsSerializable)
            {
                diagnostics.Add(Diagnostic("beat-out-of-range", "Note beat exceeds the exact integer range shared with JavaScript.", range, block.Difficulty));
                editable = false;
                return;
            }

            if (!SimaiNoteParser.TryGetSingleNote(seconds, bpm, token.AsSpan(), out var parsed) || parsed is null)
            {
                diagnostics.Add(Diagnostic("invalid-note", "MajSimai rejected this note; it has been preserved and the difficulty is read-only.", range, block.Difficulty));
                editable = false;
                return;
            }
            var expectedKind = isTouch ? (isHold ? "touchHold" : "touch") : (isHold ? "hold" : "tap");
            var expectedType = isTouch
                ? (isHold ? SimaiNoteType.TouchHold : SimaiNoteType.Touch)
                : (isHold ? SimaiNoteType.Hold : SimaiNoteType.Tap);
            var upstreamPosition = isTouch && touchArea == "C" ? 8 : position;
            if (parsed.Type != expectedType || parsed.StartPosition != upstreamPosition
                || (isTouch && parsed.TouchArea != touchArea![0])
                || (isTouch && parsed.IsHanabi != firework)
                || parsed.IsForceStar != forceStar || parsed.IsFakeRotate
                || !double.IsFinite(parsed.HoldTime) || parsed.HoldTime < 0)
            {
                diagnostics.Add(Diagnostic("unsupported-note-result", "MajSimai returned a note outside the strict supported note subset.", range, block.Difficulty));
                editable = false;
                return;
            }
            if (expandedNoteCount >= MaxNotesPerChart)
            {
                diagnostics.Add(Diagnostic("too-many-notes", $"A difficulty exceeds the {MaxNotesPerChart} upstream note/segment limit.", range, block.Difficulty));
                editable = false;
                return;
            }

            var durationSeconds = isHold ? parsed.HoldTime : 0d;
            if (isTouch && modifiers.Ex)
            {
                diagnostics.Add(Diagnostic("unsupported-touch-ex", "Touch EX is recognized in the source but remains read-only because the target player's behavior is not supported.", range, block.Difficulty));
                editable = false;
                return;
            }
            if (isTouch && isHold && duration.Kind == "short")
            {
                diagnostics.Add(Diagnostic("unsupported-short-touch-hold", "A TouchHold without an explicit duration remains read-only.", range, block.Difficulty));
                editable = false;
                return;
            }
            var regularNote = new ParserNoteDto
            {
                Id = $"{block.Difficulty}:{range.Start}:{expansionIndex}",
                Kind = expectedKind,
                Beat = currentBeat.ToDto(),
                Position = position,
                TouchArea = touchArea,
                Firework = firework,
                ForceStar = forceStar,
                Order = noteOrder++,
                SourceRange = range,
                StartSeconds = seconds,
                DurationSeconds = durationSeconds,
                Duration = isHold ? duration : null,
                Modifiers = new NoteModifiersDto { Break = parsed.IsBreak, Ex = parsed.IsEx }
            };
            notes.Add(regularNote);
            expandedNoteCount++;
            upstreamExpected.Add(new UpstreamNoteExpectation(
                regularNote.Kind, regularNote.Position, regularNote.TouchArea, regularNote.StartSeconds,
                regularNote.DurationSeconds, regularNote.MoveStartSeconds ?? 0, regularNote.DurationSeconds,
                regularNote.Slide, regularNote.Modifiers, regularNote.Firework, regularNote.ForceStar,
                false, regularNote.SourceRange));
        }
    }

    private static bool TryReadStrictNote(
        string token,
        out int position,
        out string? touchArea,
        out bool isTouch,
        out bool isHold,
        out bool firework,
        out bool forceStar,
        out NoteModifiersDto modifiers,
        out HoldDurationDto duration,
        out string errorCode,
        out string errorMessage,
        out int errorStart,
        out int errorEnd)
    {
        position = 0;
        touchArea = null;
        isTouch = false;
        isHold = false;
        firework = false;
        forceStar = false;
        modifiers = new();
        duration = new() { Kind = "short" };
        errorCode = "unsupported-syntax";
        errorMessage = "Only strict Tap, Hold, Touch, and Touch Hold forms are editable; unsupported note syntax is preserved and the difficulty is read-only.";
        errorStart = 0;
        errorEnd = token.Length;
        if (token.Length == 0)
            return false;
        var cursor = 0;
        if (token[0] is >= 'A' and <= 'E')
        {
            isTouch = true;
            touchArea = token[0].ToString();
            cursor = 1;
            if (touchArea == "C")
            {
                position = 0;
            }
            else if (cursor < token.Length && IsLane(token[cursor]))
            {
                position = token[cursor++] - '0';
            }
            else
            {
                errorCode = "invalid-touch-position";
                errorMessage = "Touch areas A, B, D, and E require a sensor number from 1 through 8; area C has no number.";
                errorEnd = Math.Min(token.Length, cursor + 1);
                return false;
            }
        }
        else if (IsLane(token[0]))
        {
            position = token[0] - '0';
            cursor = 1;
        }
        else
        {
            return false;
        }
        var breakFlag = false;
        var exFlag = false;
        var fireworkSeen = false;
        var forceStarSeen = false;
        var forceStarOffset = -1;
        var holdSeen = false;
        var bracketSeen = false;

        while (cursor < token.Length)
        {
            var current = token[cursor];
            if (current is 'b' or 'x')
            {
                if (current == 'b')
                {
                    if (breakFlag)
                    {
                        errorCode = "duplicate-modifier";
                        errorMessage = "Repeated BREAK modifier is not supported.";
                        errorStart = cursor;
                        errorEnd = cursor + 1;
                        return false;
                    }
                    breakFlag = true;
                }
                else
                {
                    if (exFlag)
                    {
                        errorCode = "duplicate-modifier";
                        errorMessage = "Repeated EX modifier is not supported.";
                        errorStart = cursor;
                        errorEnd = cursor + 1;
                        return false;
                    }
                    exFlag = true;
                }
                cursor++;
                continue;
            }
            if (current == '$')
            {
                if (forceStarSeen)
                {
                    errorCode = "unsupported-force-star-form";
                    errorMessage = "Exactly one '$' is supported, and only on a Tap; '$$' fake rotation remains read-only.";
                    errorStart = cursor;
                    errorEnd = cursor + 1;
                    return false;
                }
                forceStarSeen = true;
                forceStar = true;
                forceStarOffset = cursor;
                cursor++;
                continue;
            }
            if (current == 'f')
            {
                if (!isTouch)
                {
                    errorCode = "firework-on-non-touch";
                    errorMessage = "Firework modifier f is supported only on Touch and Touch Hold notes.";
                    errorStart = cursor;
                    errorEnd = cursor + 1;
                    return false;
                }
                if (fireworkSeen)
                {
                    errorCode = "duplicate-modifier";
                    errorMessage = "Repeated Firework modifier f is not supported.";
                    errorStart = cursor;
                    errorEnd = cursor + 1;
                    return false;
                }
                if (holdSeen || bracketSeen)
                {
                    errorCode = "misplaced-firework-modifier";
                    errorMessage = "Firework modifier f must follow the Touch sensor and precede the Hold marker.";
                    errorStart = cursor;
                    errorEnd = cursor + 1;
                    return false;
                }
                firework = true;
                fireworkSeen = true;
                cursor++;
                continue;
            }
            if (current == 'h')
            {
                if (holdSeen)
                {
                    errorCode = "unsupported-syntax";
                    errorMessage = "Repeated Hold marker is not supported.";
                    errorStart = cursor;
                    errorEnd = cursor + 1;
                    return false;
                }
                holdSeen = true;
                cursor++;
                continue;
            }
            if (current == '[')
            {
                var open = cursor;
                var close = token.IndexOf(']', open + 1);
                if (!holdSeen || bracketSeen || close < 0 || !TryParseHoldDuration(token[(open + 1)..close], out duration))
                {
                    errorCode = "invalid-hold-duration";
                    errorMessage = "Hold duration must follow a Hold marker and use a finite non-negative seconds value or a positive division with a non-negative beat count.";
                    errorStart = open;
                    errorEnd = close < 0 ? token.Length : close + 1;
                    return false;
                }
                bracketSeen = true;
                cursor = close + 1;
                continue;
            }

            errorCode = "unconsumed-content";
            errorMessage = "MajSimai syntax following this position is not in the strict Tap/Hold subset.";
            errorStart = cursor;
            errorEnd = token.Length;
            return false;
        }

        isHold = holdSeen;
        if (forceStar && (isTouch || isHold))
        {
            errorCode = "force-star-note-kind";
            errorMessage = "Static star '$' is supported only on Tap notes.";
            errorStart = forceStarOffset;
            errorEnd = forceStarOffset + 1;
            return false;
        }
        if (!isHold && bracketSeen)
            return false;
        modifiers = new NoteModifiersDto { Break = breakFlag, Ex = exFlag };
        return true;
    }

    private static bool ContainsSlideCommand(string token)
    {
        for (var index = 0; index < token.Length; index++)
        {
            if (token[index] == '[') return false;
            if (IsAnySlideCommand(token[index])) return true;
        }
        return false;
    }

    private static bool IsAnySlideCommand(char value) =>
        value is '-' or '<' or '>' or 'w' or '^' or 'v' or 'V' or 'p' or 'q' or 's' or 'z' or 'K';

    private static bool IsSupportedSlideCommand(char value) => value is '-' or '<' or '>' or 'w' or 'v' or 's' or 'z';

    private static bool IsValidSlideDistance(char command, int distance) => command switch
    {
        '-' => distance is >= 2 and <= 6,
        'w' or 's' or 'z' => distance == 4,
        'v' => distance is 1 or 2 or 3 or 5 or 6 or 7,
        _ => true
    };

    private static string SlideDistanceError(char command) => command switch
    {
        '-' => "Straight slides require a serialized path at ring distance 2 through 6.",
        'w' => "Wi-Fi slides require an endpoint exactly four lanes opposite the segment start.",
        'v' => "v slides require ring distance 1, 2, 3, 5, 6, or 7.",
        's' or 'z' => $"{command} slides require an endpoint exactly four lanes opposite the segment start.",
        _ => "Slide path has an invalid endpoint distance."
    };

    private static bool IsSlideAngleCommand(string source, int segmentStart, int markerIndex, int parseEnd)
    {
        var previous = markerIndex - 1;
        while (previous >= segmentStart && char.IsWhiteSpace(source[previous])) previous--;
        if (previous >= segmentStart && source[previous] == '*')
            return true;

        var branchSeparator = markerIndex - 1;
        while (branchSeparator >= segmentStart && source[branchSeparator] != '/' && source[branchSeparator] != '*') branchSeparator--;
        if (branchSeparator >= segmentStart && source[branchSeparator] == '*')
        {
            var branchStart = branchSeparator + 1;
            while (branchStart < markerIndex && char.IsWhiteSpace(source[branchStart])) branchStart++;
            var branchEnd = branchStart + 1;
            while (branchEnd < markerIndex && char.IsWhiteSpace(source[branchEnd])) branchEnd++;
            if (branchEnd < markerIndex
                && IsAnySlideCommand(source[branchStart])
                && IsLane(source[branchEnd]))
                return true;
        }

        var componentStart = markerIndex - 1;
        while (componentStart >= segmentStart && source[componentStart] != '/') componentStart--;
        componentStart++;
        while (componentStart < markerIndex && char.IsWhiteSpace(source[componentStart])) componentStart++;
        var destinationIndex = markerIndex + 1;
        while (destinationIndex < parseEnd && char.IsWhiteSpace(source[destinationIndex])) destinationIndex++;
        if (componentStart >= markerIndex || !IsLane(source[componentStart]) || destinationIndex >= parseEnd || !char.IsDigit(source[destinationIndex]))
            return false;

        var priorRoute = false;
        for (var index = componentStart + 1; index < markerIndex; index++)
        {
            var value = source[index];
            if (char.IsWhiteSpace(value)) continue;
            if (IsAnySlideCommand(value))
            {
                priorRoute = true;
                continue;
            }
            if (value is not ('b' or 'x' or '@' or '!' or '?' or '$' or 'f' or 'm' or 'c' or '[' or ']' or ':' or '.' or '#')
                && !char.IsDigit(value))
                return false;
        }
        return priorRoute || Enumerable.Range(componentStart + 1, markerIndex - componentStart - 1)
            .All(index => char.IsWhiteSpace(source[index]) || source[index] is 'b' or 'x' or '@' or '!' or '?' or '$' or 'f' or 'm' or 'c');
    }

    private static bool TryReadStrictSlide(
        string token,
        out StrictSlide slide,
        out bool unsupportedFeature,
        out string errorCode,
        out string errorMessage,
        out int errorStart,
        out int errorEnd)
    {
        slide = null!;
        unsupportedFeature = false;
        errorCode = "unsupported-slide-syntax";
        errorMessage = "A slide must contain one through 64 supported connected segments per path.";
        errorStart = 0;
        errorEnd = token.Length;

        var segments = token.Split('*');
        if (segments.Length is < 1 or > 64)
        {
            errorCode = "unsupported-slide-path-count";
            errorMessage = "Shared-head slides must contain between one and 64 non-empty paths.";
            return false;
        }
        if (!TryReadStrictSlideSegment(segments[0], out var first, out unsupportedFeature,
                out errorCode, out errorMessage, out errorStart, out errorEnd))
            return false;

        var additionalPaths = new SlidePathDto[segments.Length - 1];
        var segmentCount = first.SegmentCount;
        var offset = segments[0].Length + 1;
        for (var index = 1; index < segments.Length; index++)
        {
            if (!TryReadAdditionalSlidePath(segments[index], first.StartPosition, out var path,
                    out errorCode, out errorMessage, out errorStart, out errorEnd))
            {
                errorStart += offset;
                errorEnd += offset;
                return false;
            }
            additionalPaths[index - 1] = path;
            segmentCount += 1 + path.Continuations.Length;
            offset += segments[index].Length + 1;
        }

        slide = first with
        {
            Dto = new SlideDto
            {
                Command = first.Dto.Command,
                EndPosition = first.Dto.EndPosition,
                Head = first.Dto.Head,
                SlideBreak = first.Dto.SlideBreak,
                Wait = first.Dto.Wait,
                Move = first.Dto.Move,
                Continuations = first.Dto.Continuations,
                AdditionalPaths = additionalPaths
            },
            SegmentCount = segmentCount
        };
        return true;
    }

    private static bool TryReadStrictSlideSegment(
        string token,
        out StrictSlide slide,
        out bool unsupportedFeature,
        out string errorCode,
        out string errorMessage,
        out int errorStart,
        out int errorEnd)
    {
        slide = null!;
        unsupportedFeature = false;
        errorCode = "unsupported-slide-syntax";
        errorMessage = "The first shared-head path must use supported -, <, >, v, s, z, or atomic w segments followed by one total-duration bracket.";
        errorStart = 0;
        errorEnd = token.Length;
        if (token.Length < 5 || !IsLane(token[0])) return false;

        var open = token.IndexOf('[');
        var close = open < 0 ? -1 : token.IndexOf(']', open + 1);
        var secondOpen = open < 0 ? -1 : token.IndexOf('[', open + 1);
        var secondClose = close < 0 ? -1 : token.IndexOf(']', close + 1);
        var routeCommandCount = token.Take(open < 0 ? token.Length : open).Count(IsAnySlideCommand);
        var postBracketEnd = secondOpen >= 0 ? secondOpen : token.Length;
        var commandAfterBracket = close < 0 ? -1 : Enumerable.Range(close + 1, Math.Max(0, postBracketEnd - close - 1))
            .FirstOrDefault(index => IsAnySlideCommand(token[index]), -1);
        if (commandAfterBracket >= 0)
        {
            errorCode = "unsupported-connected-slide-timing";
            errorMessage = "A connected route's single duration bracket must follow its final segment; per-segment timing remains read-only.";
            errorStart = commandAfterBracket;
            errorEnd = postBracketEnd;
            return false;
        }
        if ((secondOpen >= 0 || secondClose >= 0) && routeCommandCount > 1)
        {
            errorCode = "unsupported-connected-slide-timing";
            errorMessage = "Connected slide segments must use one final whole-route duration bracket; per-segment brackets remain read-only.";
            errorStart = secondOpen >= 0 ? secondOpen : secondClose;
            errorEnd = token.Length;
            return false;
        }
        if (open < 0 || close < 0 || secondOpen >= 0 || secondClose >= 0)
        {
            errorCode = "invalid-slide-duration";
            errorMessage = "A slide path must contain exactly one complete final duration bracket.";
            errorStart = Math.Max(0, open);
            errorEnd = token.Length;
            return false;
        }

        var cursor = 1;
        var startBreak = false;
        var ex = false;
        var tapHead = false;
        var noHead = false;
        var questionHead = false;
        var forceStar = false;
        var forceStarTagCount = 0;
        var unsupportedFlag = false;
        while (cursor < open && !IsAnySlideCommand(token[cursor]))
        {
            var index = cursor++;
            switch (token[index])
            {
                case 'b':
                    if (startBreak) return FailSlideParse("duplicate-slide-modifier", "Repeated slide modifiers are not supported.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    startBreak = true;
                    break;
                case 'x':
                    if (ex) return FailSlideParse("duplicate-slide-modifier", "Repeated slide modifiers are not supported.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    ex = true;
                    break;
                case '@':
                    if (tapHead || noHead || questionHead) return FailSlideParse("conflicting-slide-head", "A slide may use only one of @, !, or ? as its head marker.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    tapHead = true;
                    break;
                case '!':
                    if (tapHead || noHead || questionHead) return FailSlideParse("conflicting-slide-head", "A slide may use only one of @, !, or ? as its head marker.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    noHead = true;
                    break;
                case '?':
                    if (tapHead || noHead || questionHead) return FailSlideParse("conflicting-slide-head", "A slide may use only one of @, !, or ? as its head marker.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    questionHead = true;
                    unsupportedFlag = true;
                    break;
                case '$':
                    forceStar = true;
                    forceStarTagCount++;
                    unsupportedFlag = true;
                    break;
                case 'f': case 'm': case 'c':
                    unsupportedFlag = true;
                    break;
                default:
                    return FailSlideParse("unconsumed-slide-content", "Connected paths or unsupported branch modifiers remain read-only.", index, token.Length, out errorCode, out errorMessage, out errorStart, out errorEnd);
            }
        }

        var route = new List<(char Command, int EndPosition, int CommandIndex)>();
        var routeStart = token[0] - '0';
        while (cursor < open && IsAnySlideCommand(token[cursor]))
        {
            var commandIndex = cursor;
            var command = token[cursor++];
            if (!IsSupportedSlideCommand(command))
                return FailSlideParse("unsupported-slide-command", "Only -, <, >, v, s, z, and atomic w path segments are supported; other path shapes remain read-only.", commandIndex, commandIndex + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
            if (cursor >= open || !IsLane(token[cursor]))
                return FailSlideParse("invalid-slide-path", "Every slide command must end at a lane from 1 through 8.", commandIndex, Math.Min(open, cursor + 1), out errorCode, out errorMessage, out errorStart, out errorEnd);

            var endPosition = token[cursor++] - '0';
            var distance = (endPosition - routeStart + 8) % 8;
            if (!IsValidSlideDistance(command, distance))
            {
                errorCode = "unsupported-slide-path";
                errorMessage = SlideDistanceError(command);
                errorStart = commandIndex;
                errorEnd = cursor;
                return false;
            }
            if (route.Count == MaxSlideSegmentsPerPath)
                return FailSlideParse("unsupported-slide-segment-count", $"A slide path may contain at most {MaxSlideSegmentsPerPath} segments.", commandIndex, cursor, out errorCode, out errorMessage, out errorStart, out errorEnd);

            route.Add((command, endPosition, commandIndex));
            routeStart = endPosition;
        }
        if (route.Count == 0)
        {
            errorCode = "invalid-slide-path";
            errorMessage = "A slide needs at least one command and endpoint.";
            errorStart = cursor;
            errorEnd = open;
            return false;
        }
        if (route.Count > 1 && route.Any(segment => segment.Command == 'w'))
        {
            var wifiIndex = route.First(segment => segment.Command == 'w').CommandIndex;
            return FailSlideParse("unsupported-connected-wifi", "Wi-Fi slides are atomic and cannot be chained to another segment.", wifiIndex, wifiIndex + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
        }

        var slideBreak = false;
        for (var index = cursor; index < open; index++)
        {
            switch (token[index])
            {
                case 'b':
                    if (slideBreak) return FailSlideParse("duplicate-slide-modifier", "Repeated slide modifiers are not supported.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    slideBreak = true;
                    break;
                case 'x':
                    if (ex) return FailSlideParse("duplicate-slide-modifier", "Repeated slide modifiers are not supported.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    ex = true;
                    break;
                case '$':
                    forceStar = true;
                    forceStarTagCount++;
                    unsupportedFlag = true;
                    break;
                case 'f': case 'm': case 'c':
                    unsupportedFlag = true;
                    break;
                default:
                    return FailSlideParse("unconsumed-slide-content", "Connected paths or unsupported branch modifiers remain read-only.", index, token.Length, out errorCode, out errorMessage, out errorStart, out errorEnd);
            }
        }
        for (var index = close + 1; index < token.Length; index++)
        {
            switch (token[index])
            {
                case 'b':
                    if (slideBreak) return FailSlideParse("duplicate-slide-modifier", "Repeated slide modifiers are not supported.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    slideBreak = true;
                    break;
                case 'x':
                    if (ex) return FailSlideParse("duplicate-slide-modifier", "Repeated slide modifiers are not supported.", index, index + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
                    ex = true;
                    break;
                case '$':
                    forceStar = true;
                    forceStarTagCount++;
                    unsupportedFlag = true;
                    break;
                case 'f': case 'm': case 'c':
                    unsupportedFlag = true;
                    break;
                default:
                    return FailSlideParse("unconsumed-slide-content", "Connected paths or unsupported branch modifiers remain read-only.", index, token.Length, out errorCode, out errorMessage, out errorStart, out errorEnd);
            }
        }

        if (!TryParseSlideDurations(token[(open + 1)..close], out var wait, out var move))
        {
            errorCode = "invalid-slide-duration";
            errorMessage = "Slide timing must use a beat ratio, designated BPM ratio/seconds, or fixed-seconds wait/move pair.";
            errorStart = open;
            errorEnd = close + 1;
            return false;
        }

        var startPosition = token[0] - '0';
        var head = tapHead ? "tap" : noHead || questionHead ? "none" : "star";
        var fakeRotate = forceStarTagCount > 1;
        var modifiers = new NoteModifiersDto { Break = startBreak, Ex = ex };
        slide = new StrictSlide(
            startPosition,
            modifiers,
            forceStar,
            fakeRotate,
            new SlideDto
            {
                Command = route[0].Command.ToString(),
                EndPosition = route[0].EndPosition,
                Head = head,
                SlideBreak = slideBreak,
                Wait = wait,
                Move = move,
                Continuations = route.Skip(1).Select(segment => new SlideContinuationDto
                {
                    Command = segment.Command.ToString(),
                    EndPosition = segment.EndPosition
                }).ToArray()
            },
            route.Count);
        unsupportedFeature = unsupportedFlag || questionHead || forceStar;
        return true;
    }

    private static bool TryReadAdditionalSlidePath(
        string token,
        int startPosition,
        out SlidePathDto path,
        out string errorCode,
        out string errorMessage,
        out int errorStart,
        out int errorEnd)
    {
        path = null!;
        errorCode = "unsupported-slide-branch";
        errorMessage = "An additional shared-head path must use supported connected segments, optional path b, and one final total-duration bracket.";
        errorStart = 0;
        errorEnd = token.Length;
        if (token.Length < 5 || !IsSupportedSlideCommand(token[0]) || !IsLane(token[1]))
            return false;

        var open = token.IndexOf('[');
        var close = open < 0 ? -1 : token.IndexOf(']', open + 1);
        var secondOpen = open < 0 ? -1 : token.IndexOf('[', open + 1);
        var secondClose = close < 0 ? -1 : token.IndexOf(']', close + 1);
        var routeCommandCount = token.Take(open < 0 ? token.Length : open).Count(IsAnySlideCommand);
        var postBracketEnd = secondOpen >= 0 ? secondOpen : token.Length;
        var commandAfterBracket = close < 0 ? -1 : Enumerable.Range(close + 1, Math.Max(0, postBracketEnd - close - 1))
            .FirstOrDefault(index => IsAnySlideCommand(token[index]), -1);
        if (commandAfterBracket >= 0)
        {
            errorCode = "unsupported-connected-slide-timing";
            errorMessage = "A connected route's single duration bracket must follow its final segment; per-segment timing remains read-only.";
            errorStart = commandAfterBracket;
            errorEnd = postBracketEnd;
            return false;
        }
        if ((secondOpen >= 0 || secondClose >= 0) && routeCommandCount > 1)
        {
            errorCode = "unsupported-connected-slide-timing";
            errorMessage = "Connected slide segments must use one final whole-route duration bracket; per-segment brackets remain read-only.";
            errorStart = secondOpen >= 0 ? secondOpen : secondClose;
            errorEnd = token.Length;
            return false;
        }
        if (open < 2 || close < 0 || secondOpen >= 0 || secondClose >= 0)
        {
            errorCode = "invalid-slide-duration";
            errorMessage = "Each additional shared-head path must contain exactly one complete final duration bracket.";
            errorStart = Math.Max(0, open);
            errorEnd = token.Length;
            return false;
        }

        var route = new List<(char Command, int EndPosition, int CommandIndex)>();
        var routeStart = startPosition;
        var cursor = 0;
        while (cursor < open && IsAnySlideCommand(token[cursor]))
        {
            var commandIndex = cursor;
            var command = token[cursor++];
            if (!IsSupportedSlideCommand(command))
                return FailSlideParse("unsupported-slide-command", "Only -, <, >, v, s, z, and atomic w path segments are supported; other path shapes remain read-only.", commandIndex, commandIndex + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
            if (cursor >= open || !IsLane(token[cursor]))
                return FailSlideParse("invalid-slide-path", "Every slide command must end at a lane from 1 through 8.", commandIndex, Math.Min(open, cursor + 1), out errorCode, out errorMessage, out errorStart, out errorEnd);

            var endPosition = token[cursor++] - '0';
            var distance = (endPosition - routeStart + 8) % 8;
            if (!IsValidSlideDistance(command, distance))
            {
                errorCode = "unsupported-slide-path";
                errorMessage = SlideDistanceError(command);
                errorStart = commandIndex;
                errorEnd = cursor;
                return false;
            }
            if (route.Count == MaxSlideSegmentsPerPath)
                return FailSlideParse("unsupported-slide-segment-count", $"A slide path may contain at most {MaxSlideSegmentsPerPath} segments.", commandIndex, cursor, out errorCode, out errorMessage, out errorStart, out errorEnd);

            route.Add((command, endPosition, commandIndex));
            routeStart = endPosition;
        }
        if (route.Count == 0)
            return false;
        if (route.Count > 1 && route.Any(segment => segment.Command == 'w'))
        {
            var wifiIndex = route.First(segment => segment.Command == 'w').CommandIndex;
            return FailSlideParse("unsupported-connected-wifi", "Wi-Fi slides are atomic and cannot be chained to another segment.", wifiIndex, wifiIndex + 1, out errorCode, out errorMessage, out errorStart, out errorEnd);
        }

        var slideBreak = false;
        for (var index = cursor; index < open; index++)
        {
            if (token[index] != 'b' || slideBreak)
            {
                errorStart = index;
                errorEnd = index + 1;
                return false;
            }
            slideBreak = true;
        }
        for (var index = close + 1; index < token.Length; index++)
        {
            if (token[index] != 'b' || slideBreak)
            {
                errorStart = index;
                errorEnd = index + 1;
                return false;
            }
            slideBreak = true;
        }

        if (!TryParseSlideDurations(token[(open + 1)..close], out var wait, out var move))
        {
            errorCode = "invalid-slide-duration";
            errorMessage = "Slide timing must use a beat ratio, designated BPM ratio/seconds, or fixed-seconds wait/move pair.";
            errorStart = open;
            errorEnd = close + 1;
            return false;
        }

        path = new SlidePathDto
        {
            Command = route[0].Command.ToString(),
            EndPosition = route[0].EndPosition,
            SlideBreak = slideBreak,
            Wait = wait,
            Move = move,
            Continuations = route.Skip(1).Select(segment => new SlideContinuationDto
            {
                Command = segment.Command.ToString(),
                EndPosition = segment.EndPosition
            }).ToArray()
        };
        return true;
    }

    private static bool TryParseSlideDurations(string text, out HoldDurationDto wait, out HoldDurationDto move)
    {
        wait = new() { Kind = "short" };
        move = new() { Kind = "short" };
        var parts = text.Split('#');
        switch (parts.Length)
        {
            case 1:
                if (!TryParseRatio(parts[0], out var defaultDivision, out var defaultBeats)) return false;
                wait = BeatsAtStartBpm(4, 1);
                move = BeatsAtStartBpm(defaultDivision, defaultBeats);
                return true;
            case 2:
                if (!TryFiniteDouble(parts[0], out var bpm) || bpm <= 0 || parts[1].Length == 0) return false;
                wait = BeatsAtBpm(bpm, 4, 1);
                if (TryFiniteDouble(parts[1], out var fixedMoveSeconds))
                {
                    if (fixedMoveSeconds < 0) return false;
                    move = new() { Kind = "seconds", Seconds = fixedMoveSeconds };
                    return true;
                }
                if (!TryParseRatio(parts[1], out var explicitDivision, out var explicitBeats)) return false;
                move = BeatsAtBpm(bpm, explicitDivision, explicitBeats);
                return true;
            case 3:
                if (parts[1].Length != 0 || !TryFiniteDouble(parts[0], out var fixedWaitSeconds) || fixedWaitSeconds < 0)
                    return false;
                wait = new() { Kind = "seconds", Seconds = fixedWaitSeconds };
                if (TryFiniteDouble(parts[2], out var moveSeconds))
                {
                    if (moveSeconds < 0) return false;
                    move = new() { Kind = "seconds", Seconds = moveSeconds };
                    return true;
                }
                if (!TryParseRatio(parts[2], out var sourceDivision, out var sourceBeats)) return false;
                move = BeatsAtStartBpm(sourceDivision, sourceBeats);
                return true;
            case 4:
                if (parts[1].Length != 0 || !TryFiniteDouble(parts[0], out var customWaitSeconds) || customWaitSeconds < 0
                    || !TryFiniteDouble(parts[2], out var moveBpm) || moveBpm <= 0
                    || !TryParseRatio(parts[3], out var customDivision, out var customBeats))
                    return false;
                wait = new() { Kind = "seconds", Seconds = customWaitSeconds };
                move = BeatsAtBpm(moveBpm, customDivision, customBeats);
                return true;
            default:
                return false;
        }

        static HoldDurationDto BeatsAtStartBpm(double division, double beats) => new()
        {
            Kind = "beatsAtStartBpm", Division = division, Beats = beats
        };

        static HoldDurationDto BeatsAtBpm(double bpm, double division, double beats) => new()
        {
            Kind = "beatsAtBpm", Bpm = bpm, Division = division, Beats = beats
        };
    }

    private static bool TryGetDurationSeconds(HoldDurationDto duration, double sourceBpm, out double seconds)
    {
        seconds = 0;
        if (duration.Kind == "seconds")
        {
            seconds = duration.Seconds ?? double.NaN;
            return double.IsFinite(seconds) && seconds >= 0;
        }
        if (duration.Kind is not ("beatsAtStartBpm" or "beatsAtBpm")) return false;
        var bpm = duration.Kind == "beatsAtStartBpm" ? sourceBpm : duration.Bpm ?? double.NaN;
        var division = duration.Division ?? double.NaN;
        var beats = duration.Beats ?? double.NaN;
        if (!double.IsFinite(bpm) || bpm <= 0 || !double.IsFinite(division) || division <= 0
            || !double.IsFinite(beats) || beats < 0)
            return false;
        seconds = (60d / bpm) * 4d / division * beats;
        return double.IsFinite(seconds) && seconds >= 0;
    }

    private static bool MatchesSlideEvent(SimaiNote actual, UpstreamNoteExpectation expected)
    {
        var slide = expected.Slide;
        return slide is not null
            && actual.Type == SimaiNoteType.Slide
            && actual.StartPosition == expected.Position
            && actual.IsBreak == expected.Modifiers.Break
            && actual.IsEx == expected.Modifiers.Ex
            && actual.IsSlideBreak == slide.SlideBreak
            && actual.IsTapHeadSlide == (slide.Head == "tap")
            && actual.IsSlideNoHead == (slide.Head == "none")
            && actual.IsForceStar == expected.ForceStar
            && actual.IsFakeRotate == expected.FakeRotate
            && Math.Abs(actual.SlideStartTime - expected.MoveStartSeconds) <= UpstreamTimingToleranceSeconds
            && Math.Abs(actual.SlideTime - expected.MoveSeconds) <= 1e-9;
    }

    private static bool TryParseHoldDuration(string text, out HoldDurationDto duration)
    {
        duration = new() { Kind = "short" };
        if (text.StartsWith('#'))
        {
            if (!TryFiniteDouble(text[1..], out var seconds) || seconds < 0)
                return false;
            duration = new() { Kind = "seconds", Seconds = seconds };
            return true;
        }

        var firstHash = text.IndexOf('#');
        if (firstHash >= 0)
        {
            if (firstHash == 0 || firstHash == text.Length - 1 || !TryFiniteDouble(text[..firstHash], out var bpm) || bpm <= 0)
                return false;
            if (!TryParseRatio(text[(firstHash + 1)..], out var division, out var beats))
                return false;
            duration = new() { Kind = "beatsAtBpm", Bpm = bpm, Division = division, Beats = beats };
            return true;
        }

        if (!TryParseRatio(text, out var defaultDivision, out var defaultBeats))
            return false;
        duration = new() { Kind = "beatsAtStartBpm", Division = defaultDivision, Beats = defaultBeats };
        return true;
    }

    private static bool TryParseRatio(string text, out double division, out double beats)
    {
        division = 0;
        beats = 0;
        var colon = text.IndexOf(':');
        return colon > 0 && colon < text.Length - 1
            && int.TryParse(text[..colon], NumberStyles.None, CultureInfo.InvariantCulture, out var parsedDivision)
            && parsedDivision > 0
            && int.TryParse(text[(colon + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var parsedBeats)
            && parsedBeats >= 0
            && SetValues(parsedDivision, parsedBeats, out division, out beats);

        static bool SetValues(int parsedDivision, int parsedBeats, out double divisionValue, out double beatValue)
        {
            divisionValue = parsedDivision;
            beatValue = parsedBeats;
            return true;
        }
    }

    private static bool FailSlideParse(
        string code,
        string message,
        int start,
        int end,
        out string errorCode,
        out string errorMessage,
        out int errorStart,
        out int errorEnd)
    {
        errorCode = code;
        errorMessage = message;
        errorStart = start;
        errorEnd = end;
        return false;
    }

    private static bool TryDecimalRational(string text, out BigRational rational)
    {
        rational = default;
        if (!decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            return false;
        var bits = decimal.GetBits(value);
        var scale = (bits[3] >> 16) & 0x7F;
        var negative = (bits[3] & int.MinValue) != 0;
        var integer = (BigInteger)(uint)bits[0] | ((BigInteger)(uint)bits[1] << 32) | ((BigInteger)(uint)bits[2] << 64);
        if (negative) integer = -integer;
        rational = new BigRational(integer, BigInteger.Pow(10, scale));
        return true;
    }

    private static bool TryFiniteDouble(string text, out double value) =>
        double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) && double.IsFinite(value);

    private static int FindTerminalE(string source)
    {
        var end = source.Length;
        while (end > 0 && char.IsWhiteSpace(source[end - 1])) end--;
        if (end == 0 || source[end - 1] != 'E') return -1;
        var segmentStart = end - 1;
        while (segmentStart > 0 && source[segmentStart - 1] != ',') segmentStart--;
        for (var i = segmentStart; i < end - 1; i++)
        {
            if (!char.IsWhiteSpace(source[i])) return -1;
        }
        return end - 1;
    }

    private static bool IsLane(char value) => value is >= '1' and <= '8';

    private static int? ParseDifficultyName(string name, string prefix)
    {
        if (!name.StartsWith(prefix, StringComparison.Ordinal)) return null;
        return int.TryParse(name.AsSpan(prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    private static bool IsKnownField(string name) =>
        name is "title" or "artist" or "first" or "des"
        || ParseDifficultyName(name, "lv_") is >= 1 and <= 7
        || ParseDifficultyName(name, "des_") is >= 1 and <= 7
        || ParseDifficultyName(name, "inote_") is >= 1 and <= 7;

    private static List<LineInfo> GetLines(string source)
    {
        var result = new List<LineInfo>();
        var start = 0;
        while (start < source.Length)
        {
            var newline = source.IndexOf('\n', start);
            var next = newline < 0 ? source.Length : newline + 1;
            var contentEnd = newline < 0 ? source.Length : newline;
            if (contentEnd > start && source[contentEnd - 1] == '\r') contentEnd--;
            result.Add(new(start, contentEnd, next));
            start = next;
        }
        if (source.Length == 0 || (source.Length > 0 && source[^1] == '\n'))
            result.Add(new(source.Length, source.Length, source.Length));
        return result;
    }

    private static (int Start, int End) TrimBounds(string source, int start, int end, bool firstLine)
    {
        if (firstLine && start < end && source[start] == '\uFEFF') start++;
        while (start < end && char.IsWhiteSpace(source[start])) start++;
        while (end > start && char.IsWhiteSpace(source[end - 1])) end--;
        return (start, end);
    }

    private static ChartText BuildChartText(string source, List<LineInfo> lines, int firstLine, int lastLine, int valueStart, int firstHeaderEnd)
    {
        var characters = new List<char>();
        var offsets = new List<int>();

        void AppendRange(int start, int end)
        {
            for (var i = start; i < end; i++)
            {
                characters.Add(source[i]);
                offsets.Add(i);
            }
        }

        var first = lines[firstLine];
        AppendRange(valueStart, Math.Min(firstHeaderEnd, first.ContentEnd));
        AppendNewline(first);
        for (var index = firstLine + 1; index <= lastLine; index++)
        {
            var line = lines[index];
            var bounds = TrimBounds(source, line.Start, line.ContentEnd, false);
            if (bounds.Start < bounds.End)
                AppendRange(bounds.Start, bounds.End);
            AppendNewline(line);
        }

        void AppendNewline(LineInfo line)
        {
            if (line.NextStart <= line.ContentEnd) return;
            characters.Add('\n');
            offsets.Add(line.NextStart - 1);
        }

        var trimStart = 0;
        var trimEnd = characters.Count;
        while (trimStart < trimEnd && char.IsWhiteSpace(characters[trimStart])) trimStart++;
        while (trimEnd > trimStart && char.IsWhiteSpace(characters[trimEnd - 1])) trimEnd--;
        var text = new string(characters.Skip(trimStart).Take(trimEnd - trimStart).ToArray());
        var map = offsets.Skip(trimStart).Take(trimEnd - trimStart).ToArray();
        var range = map.Length == 0
            ? new SourceRangeDto(valueStart, valueStart)
            : new SourceRangeDto(map[0], map[^1] + 1);
        return new(text, map, range);
    }

    private static DiagnosticDto Diagnostic(string code, string message, SourceRangeDto range, int? difficulty = null, string severity = "error") => new()
    {
        Code = code,
        Message = message,
        Severity = severity,
        Range = range,
        Difficulty = difficulty
    };

    private sealed record StrictSlide(int StartPosition, NoteModifiersDto Modifiers, bool ForceStar, bool FakeRotate, SlideDto Dto, int SegmentCount);

    private sealed record UpstreamNoteExpectation(
        string Kind,
        int Position,
        string? TouchArea,
        double StartSeconds,
        double DurationSeconds,
        double MoveStartSeconds,
        double MoveSeconds,
        SlideDto? Slide,
        NoteModifiersDto Modifiers,
        bool Firework,
        bool ForceStar,
        bool FakeRotate,
        SourceRangeDto SourceRange);

    private readonly record struct LineInfo(int Start, int ContentEnd, int NextStart);

    private sealed record ChartText(string Text, int[] SourceOffsets, SourceRangeDto SourceRange);

    private sealed record ChartBlock(int Difficulty, SourceFieldDto Field, string Text, int[] SourceOffsets, SourceRangeDto SourceRange)
    {
        internal SourceRangeDto? MapRange(int start, int end)
        {
            if (SourceOffsets.Length == 0) return null;
            start = Math.Clamp(start, 0, SourceOffsets.Length);
            end = Math.Clamp(end, start, SourceOffsets.Length);
            if (start == end) return new(SourceOffsets[Math.Min(start, SourceOffsets.Length - 1)], SourceOffsets[Math.Min(start, SourceOffsets.Length - 1)]);
            return new(SourceOffsets[start], SourceOffsets[end - 1] + 1);
        }
    }

    private readonly record struct BigRational
    {
        internal BigInteger Numerator { get; }
        internal BigInteger Denominator { get; }

        internal BigRational(BigInteger numerator, BigInteger denominator)
        {
            if (denominator.IsZero) throw new DivideByZeroException();
            if (denominator.Sign < 0)
            {
                numerator = -numerator;
                denominator = -denominator;
            }
            var gcd = BigInteger.GreatestCommonDivisor(BigInteger.Abs(numerator), denominator);
            Numerator = numerator / gcd;
            Denominator = denominator / gcd;
        }

        public static BigRational operator +(BigRational left, BigRational right) =>
            new(left.Numerator * right.Denominator + right.Numerator * left.Denominator, left.Denominator * right.Denominator);

        public static BigRational operator *(BigRational left, BigRational right) =>
            new(left.Numerator * right.Numerator, left.Denominator * right.Denominator);

        public static BigRational operator /(BigRational left, BigRational right) =>
            new(left.Numerator * right.Denominator, left.Denominator * right.Numerator);

        internal double ToDouble() => (double)Numerator / (double)Denominator;

        internal bool IsSerializable
        {
            get
            {
                const long maxSafeInteger = 9_007_199_254_740_991;
                return BigInteger.Abs(Numerator) <= maxSafeInteger && Denominator <= maxSafeInteger;
            }
        }

        internal RationalDto ToDto()
        {
            if (!IsSerializable)
                throw new OverflowException("Rational chart position exceeds the interoperable integer range.");
            return new((long)Numerator, (long)Denominator);
        }
    }
}

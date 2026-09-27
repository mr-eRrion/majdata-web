using System.Text.Json;
using EditorScene.Check;
using Gameplay.Data;
using Global.Chart;

if (args.Length != 3)
{
    Console.Error.WriteLine("Usage: CheckOracle <repo-root> <input.json> <output.json>");
    return 2;
}

var repoRoot = Path.GetFullPath(args[0]);
var inputPath = Path.GetFullPath(args[1]);
var outputPath = Path.GetFullPath(args[2]);
var skinPath = Path.Combine(repoRoot, "apps/web/src/skin/slide-paths.json");
var input = JsonSerializer.Deserialize<CaseInput[]>(await File.ReadAllBytesAsync(inputPath))
    ?? throw new InvalidDataException("Input must be a JSON array of cases.");
using var skinDocument = JsonDocument.Parse(await File.ReadAllBytesAsync(skinPath));
var commands = skinDocument.RootElement.GetProperty("commands");
var pathResources = skinDocument.RootElement.GetProperty("paths");
var outputs = new List<CaseOutput>(input.Length);

foreach (var testCase in input)
{
    var chart = new NotesData();
    chart.bpmList.keyframes = testCase.bpms.Select(eventData => new BpmData.BpmKeyframe(
        ToTime(eventData.beat), eventData.bpm) { type = BpmData.KeyType.Const }).ToList();
    if (chart.bpmList.keyframes.Count == 0) throw new InvalidDataException($"{testCase.name}: no BPM events.");
    chart.bpmList.ConvertKeyframes();

    foreach (var note in testCase.notes)
    {
        var hit = ToTime(note.hit);
        var end = ToTime(note.end);
        switch (note.kind)
        {
            case "tap":
                chart.taps.Add(new TapData { button = note.position, hitTime = hit, isEx = note.ex });
                break;
            case "hold":
                chart.holds.Add(new HoldData { button = note.position, hitTime = hit,
                    holdTime = end - hit, isEx = note.ex });
                break;
            case "slide":
                chart.slides.Add(new SlideData { button = note.position, hitTime = hit, isEx = note.ex,
                    hindHead = !note.head, parts = note.paths.Select(path => MakeSlidePart(hit, path,
                        commands, pathResources, testCase.name)).ToList() });
                break;
            case "touch":
                chart.touches.Add(new TouchData { button = TouchButton(note), hitTime = hit });
                break;
            case "touchHold":
                chart.toucheHolds.Add(new TouchHoldData { button = TouchButton(note), hitTime = hit,
                    holdTime = end - hit });
                break;
            default:
                throw new InvalidDataException($"{testCase.name}: unsupported note kind '{note.kind}'.");
        }
    }

    ChartWatcher.Check(chart, out var resultMap);
    var results = resultMap.SelectMany(pair => pair.Value.Select(result =>
    {
        var beat = ToQuarterBeat(pair.Key);
        return new WarningOutput(beat, result.Code,
            result.Type == ResultType.Bad ? "bad" : "warning");
    })).OrderBy(result => result.beat, RationalComparer.Instance).ToArray();
    outputs.Add(new CaseOutput(testCase.name, results));
}

Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
await File.WriteAllTextAsync(outputPath, JsonSerializer.Serialize(outputs,
    new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine($"Wrote {outputs.Count} oracle cases to {outputPath}.");
return 0;

static TimeData ToTime(RationalInput beat)
{
    if (beat.denominator <= 0) throw new InvalidDataException("Rational denominator must be positive.");
    return new TimeData(checked(beat.denominator * 4), beat.numerator);
}

static RationalOutput ToQuarterBeat(TimeData time)
{
    var normalized = time.Normalize();
    var numerator = checked(normalized.beat * 4);
    var denominator = normalized.split;
    var gcd = GreatestCommonDivisor(Math.Abs(numerator), Math.Abs(denominator));
    return new RationalOutput(numerator / gcd, denominator / gcd);
}

static long GreatestCommonDivisor(long left, long right)
{
    while (right != 0) (left, right) = (right, left % right);
    return left == 0 ? 1 : left;
}

static string TouchButton(NoteInput note)
{
    var area = note.touchArea ?? throw new InvalidDataException($"{note.id}: Touch needs touchArea.");
    return area == "C" ? "C" : $"{area}{note.position}";
}

static SlidePartData MakeSlidePart(TimeData hit, PathInput path,
    JsonElement commands, JsonElement pathResources, string caseName)
{
    var part = new SlidePartData
    {
        prepareTime = ToTime(path.start) - hit,
        moveTime = ToTime(path.end) - ToTime(path.start),
        isWifi = path.segments.Count > 0 && path.segments[0].command == "w",
    };
    if (part.isWifi)
    {
        if (path.segments.Count != 1) throw new InvalidDataException($"{caseName}: Wi-Fi route must be atomic.");
        return part;
    }

    foreach (var segment in path.segments)
    {
        var sourceCommand = segment.command;
        var distance = segment.endPosition - segment.startPosition;
        if (distance < 0) distance += 8;
        var command = sourceCommand;
        if (segment.startPosition is >= 3 and <= 6)
        {
            if (command == "<") command = ">";
            else if (command == ">") command = "<";
        }
        if (!commands.TryGetProperty(command, out var distanceMap)
            || !distanceMap.TryGetProperty(distance.ToString(), out var idValue))
            throw new InvalidDataException($"{caseName}: no skin path for {sourceCommand} {segment.startPosition}->{segment.endPosition}.");
        var pathId = idValue.GetInt32().ToString();
        var sourcePath = pathResources.GetProperty(pathId);
        var areas = sourcePath.GetProperty("enterAreaData").EnumerateArray().Select(area => new SlideEnterAreaData
        {
            area = area.GetProperty("area").GetInt32(),
            timeRate = area.GetProperty("timeRate").GetSingle(),
        }).ToArray();
        var length = sourcePath.GetProperty("warningLength").GetSingle();
        var serializedPath = new SlidePathData { enterAreaData = areas, Length = length };
        var fragment = new SlideFragmentData
        {
            endButton = segment.endPosition,
            Path = serializedPath,
            Length = length,
        };
        part.fragments.Add(fragment);
        part.Length += fragment.Length;
    }
    return part;
}

internal sealed class RationalComparer : IComparer<RationalOutput>
{
    public static RationalComparer Instance { get; } = new();
    public int Compare(RationalOutput? left, RationalOutput? right)
    {
        if (ReferenceEquals(left, right)) return 0;
        if (left is null) return -1;
        if (right is null) return 1;
        return ((System.Numerics.BigInteger)left.numerator * right.denominator)
            .CompareTo((System.Numerics.BigInteger)right.numerator * left.denominator);
    }
}

internal sealed class CaseInput
{
    public string name { get; set; } = "";
    public List<NoteInput> notes { get; set; } = [];
    public List<BpmInput> bpms { get; set; } = [];
}

internal sealed class NoteInput
{
    public string id { get; set; } = "";
    public string kind { get; set; } = "";
    public int position { get; set; }
    public string? touchArea { get; set; }
    public RationalInput hit { get; set; } = new();
    public RationalInput end { get; set; } = new();
    public bool ex { get; set; }
    public bool head { get; set; }
    public List<PathInput> paths { get; set; } = [];
}

internal sealed class PathInput
{
    public RationalInput start { get; set; } = new();
    public RationalInput end { get; set; } = new();
    public List<SegmentInput> segments { get; set; } = [];
}

internal sealed class SegmentInput
{
    public string command { get; set; } = "";
    public int startPosition { get; set; }
    public int endPosition { get; set; }
}

internal sealed class BpmInput
{
    public RationalInput beat { get; set; } = new();
    public float bpm { get; set; }
}

internal sealed class RationalInput
{
    public long numerator { get; set; }
    public long denominator { get; set; } = 1;
}

internal sealed record RationalOutput(long numerator, long denominator);
internal sealed record WarningOutput(RationalOutput beat, int code, string severity);
internal sealed record CaseOutput(string name, WarningOutput[] results);

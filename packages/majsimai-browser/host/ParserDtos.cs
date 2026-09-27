namespace MajSimaiBrowser;

public sealed class ParserResult
{
    public int SchemaVersion { get; init; } = 4;
    public string ParserCommit { get; init; } = "fdb2a3e39d8997a0abbf8b4679062d854473cc77";
    public int SourceLengthUtf16 { get; init; }
    public bool GlobalEditable { get; set; } = true;
    public double FirstSeconds { get; set; }
    public SourceFieldDto[] Fields { get; set; } = [];
    public ParserChartDto[] Charts { get; set; } = [];
    public DiagnosticDto[] Diagnostics { get; set; } = [];
}

public sealed class SourceFieldDto
{
    public required string Name { get; init; }
    public required SourceRangeDto Range { get; init; }
    public required SourceRangeDto ValueRange { get; init; }
    public required string RawValue { get; init; }
}

public sealed class ParserChartDto
{
    public int Difficulty { get; init; }
    public string Level { get; set; } = "";
    public string Designer { get; set; } = "";
    public bool Editable { get; set; }
    public bool Modified { get; set; }
    public required SourceRangeDto FieldRange { get; init; }
    public required SourceRangeDto SourceRange { get; init; }
    public RationalDto EndBeat { get; set; } = new(0, 1);
    public ParserNoteDto[] Notes { get; set; } = [];
    public BpmEventDto[] Bpms { get; set; } = [];
    public DiagnosticDto[] Diagnostics { get; set; } = [];
}

public sealed class ParserNoteDto
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required RationalDto Beat { get; init; }
    public required int Position { get; init; }
    public string? TouchArea { get; init; }
    public bool Firework { get; init; }
    public bool ForceStar { get; init; }
    public required int Order { get; init; }
    public required SourceRangeDto SourceRange { get; init; }
    public required double StartSeconds { get; init; }
    public double DurationSeconds { get; init; }
    public HoldDurationDto? Duration { get; init; }
    public double? MoveStartSeconds { get; init; }
    public SlideDto? Slide { get; init; }
    public required NoteModifiersDto Modifiers { get; init; }
}

public sealed class SlideDto
{
    public required string Command { get; init; }
    public required int EndPosition { get; init; }
    public required string Head { get; init; }
    public bool SlideBreak { get; init; }
    public required HoldDurationDto Wait { get; init; }
    public required HoldDurationDto Move { get; init; }
    public SlideContinuationDto[] Continuations { get; init; } = [];
    public SlidePathDto[] AdditionalPaths { get; init; } = [];
}

public sealed class SlidePathDto
{
    public required string Command { get; init; }
    public required int EndPosition { get; init; }
    public bool SlideBreak { get; init; }
    public required HoldDurationDto Wait { get; init; }
    public required HoldDurationDto Move { get; init; }
    public SlideContinuationDto[] Continuations { get; init; } = [];
}

public sealed class SlideContinuationDto
{
    public required string Command { get; init; }
    public required int EndPosition { get; init; }
}

public sealed class HoldDurationDto
{
    public required string Kind { get; init; }
    public double? Bpm { get; init; }
    public double? Division { get; init; }
    public double? Beats { get; init; }
    public double? Seconds { get; init; }
}

public sealed class NoteModifiersDto
{
    public bool Break { get; init; }
    public bool Ex { get; init; }
}

public sealed class BpmEventDto
{
    public required RationalDto Beat { get; init; }
    public required double Bpm { get; init; }
    public SourceRangeDto? SourceRange { get; init; }
}

public sealed record RationalDto(long Numerator, long Denominator);

public sealed record SourceRangeDto(int Start, int End);

public sealed class DiagnosticDto
{
    public required string Code { get; init; }
    public required string Message { get; init; }
    public string Severity { get; init; } = "error";
    public required SourceRangeDto Range { get; init; }
    public int? Difficulty { get; init; }
}

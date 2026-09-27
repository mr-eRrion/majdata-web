using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace MajSimaiBrowser;

public static partial class WasmApi
{
    [JSExport]
    public static string ParseStrict(string sourceText)
    {
        ParserResult result;
        try
        {
            result = StrictSimaiParser.Parse(sourceText);
        }
        catch (Exception exception)
        {
            result = new ParserResult
            {
                SourceLengthUtf16 = sourceText.Length,
                GlobalEditable = false,
                Diagnostics =
                [
                    new DiagnosticDto
                    {
                        Code = "parser-failure",
                        Message = $"The parser failed closed: {exception.Message}",
                        Range = new SourceRangeDto(0, sourceText.Length)
                    }
                ]
            };
        }

        return JsonSerializer.Serialize(result, ParserJsonContext.Default.ParserResult);
    }
}

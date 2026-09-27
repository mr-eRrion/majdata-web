#if NET7_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace MajSimai.Unmanaged;
[StructLayout(LayoutKind.Sequential)]
public unsafe ref struct UnmanagedSimaiParseResult
{
    public const int CODE_NO_ERROR = 0;
    public const int CODE_INVALID_CONTENT = 1;
    public const int CODE_INTERNAL_ERROR = 2;
    public const int CODE_INVALID_SIMAI_MARKUP = 3;
    public const int CODE_INVALID_SIMAI_SYNTAX = 4;

    public required int code;
    public int errorAtLine = -1;
    public int errorAtColumn = -1;
    public int errorMsgLen = 0;
    public int errorContentLen = 0;

    public void* simaiFile = null;
    public char* errorMsgAnsi = null;
    public char* errorContentAnsi = null;

    public UnmanagedSimaiParseResult()
    {

    }
    public void Free()
    {
        Marshal.FreeHGlobal((nint)errorMsgAnsi);
        Marshal.FreeHGlobal((nint)errorContentAnsi);
        if(simaiFile is not null)
        {
            ((UnmanagedSimaiFile*)simaiFile)->Free();
            simaiFile = null;
        }
        code = -1;
        errorAtLine = -1;
        errorAtColumn = -1;
        errorMsgLen = 0;
        errorContentLen = 0;
    }
}
#endif

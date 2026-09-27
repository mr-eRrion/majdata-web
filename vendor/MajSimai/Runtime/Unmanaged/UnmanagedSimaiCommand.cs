#if NET7_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace MajSimai.Unmanaged;
[StructLayout(LayoutKind.Sequential)]
internal unsafe struct UnmanagedSimaiCommand
{
    public int prefixLen;
    public int valueLen;

    public char* prefix;
    public char* value;

    public void Free()
    {
        Marshal.FreeHGlobal((nint)prefix);
        Marshal.FreeHGlobal((nint)value);
        prefix = null;
        value = null;
        prefixLen = 0;
        valueLen = 0;
    }
}
#endif

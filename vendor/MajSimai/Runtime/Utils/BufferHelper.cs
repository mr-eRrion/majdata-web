using System;
using System.Buffers;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text;

namespace MajSimai.Utils
{
    internal static class BufferHelper
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static int EnsureBufferLength<T>(in int length, ref T[] buffer)
        {
            var arrayPool = ArrayPool<T>.Shared;
            if(length > int.MaxValue / 2)
            {
                throw new ArgumentOutOfRangeException(nameof(length));
            }
            if (length > buffer.Length)
            {
                var newLength = 16;
                while (newLength < length)
                {
                    newLength <<= 1;
                }
                var newBuffer = arrayPool.Rent(newLength);
                Array.Clear(newBuffer, 0, newBuffer.Length);
                var s1 = buffer.AsSpan();
                var s2 = newBuffer.AsSpan();
                s1.CopyTo(s2);
                arrayPool.Return(buffer);
                buffer = newBuffer;
            }
            return buffer.Length;
        }
    }
}

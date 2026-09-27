using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace MajSimai
{
    public readonly struct SimaiCommand : IEquatable<SimaiCommand>
    {
        public string Prefix { get; }
        public string Value { get; }

        readonly int _hashCode;
        public SimaiCommand(string prefix, string? value)
        {
            if (prefix is null)
            {
                throw new ArgumentNullException(nameof(prefix));
            }
            else if (prefix.Length == 0)
            {
                throw new ArgumentException("\"prefix\" cannot be empty", nameof(prefix));
            }
            Prefix = prefix;
            Value = value ?? string.Empty;
            _hashCode = HashCode.Combine(prefix, value);
        }

        public bool Equals(SimaiCommand cmd)
        {
            return cmd._hashCode == _hashCode;
        }
        public override bool Equals(object? cmd)
        {
            if (cmd is SimaiCommand cmd2)
            {
                return cmd2._hashCode == _hashCode;
            }
            return false;
        }
        public override int GetHashCode()
        {
            return _hashCode;
        }
        public static bool TryParse(ReadOnlySpan<char> content, out SimaiCommand cmd)
        {
            var index = content.IndexOf('=');
            if (index == -1)
            {
                cmd = default;
                return false;
            }
            var prefixStr = content.Slice(1, index - 1).Trim();
            var valueStr = content.Slice(index + 1).Trim();

            cmd = new SimaiCommand(new string(prefixStr),new string(valueStr));
            return true;
        }
        public static bool operator ==(SimaiCommand left, SimaiCommand right)
        {
            return left._hashCode == right._hashCode;
        }
        public static bool operator !=(SimaiCommand left, SimaiCommand right)
        {
            return left._hashCode != right._hashCode;
        }
        public static implicit operator KeyValuePair<string, string>(SimaiCommand cmd)
        {
            return new KeyValuePair<string, string>(cmd.Prefix, cmd.Value);
        }
#if NET7_0_OR_GREATER
        internal unsafe MajSimai.Unmanaged.UnmanagedSimaiCommand ToUnmanaged()
        {
            var prefixPtr = (char*)null;
            var valuePtr = (char*)null;

            if(!string.IsNullOrEmpty(Prefix))
            {
                prefixPtr = (char*)Marshal.StringToHGlobalAnsi(Prefix);
            }
            if (!string.IsNullOrEmpty(Value))
            {
                valuePtr = (char*)Marshal.StringToHGlobalAnsi(Value);
            }
            return new()
            {
                prefix = prefixPtr,
                prefixLen = Prefix.Length,

                value = valuePtr,
                valueLen = Value.Length
            };
        }
#endif
    }
}

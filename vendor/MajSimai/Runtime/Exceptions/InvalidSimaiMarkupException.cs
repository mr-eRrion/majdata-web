using System;
using System.Collections.Generic;
using System.Text;

namespace MajSimai
{
    public class InvalidSimaiMarkupException: FormatException
    {
        public int Line { get; }
        public int Column { get; }
        public string Content { get; }
        public InvalidSimaiMarkupException(int line, int column, string content) : base()
        {
            Line = line;
            Column = column;
            Content = content;
        }
        public InvalidSimaiMarkupException(int line, int column, string content,string message) : base(message)
        {
            Line = line;
            Column = column;
            Content = content;
        }
    }
}

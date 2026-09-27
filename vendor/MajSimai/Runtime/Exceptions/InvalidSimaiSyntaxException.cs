using System;
using System.Collections.Generic;
using System.Text;

namespace MajSimai
{
    public class InvalidSimaiSyntaxException : InvalidSimaiMarkupException
    {
        public InvalidSimaiSyntaxException(int line, int column, string content) : base(line,column,content)
        {

        }
        public InvalidSimaiSyntaxException(int line, int column, string content, string message) : base(line,column,content,message)
        {

        }
    }
}

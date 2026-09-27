using Gameplay.Data;
using Global.Chart;

namespace EditorScene.Check
{
    public enum ResultType { Bad, Warning }
}

namespace Global.Utils
{
    public class MonoSingleton<T> where T : new()
    {
        public static T Instance { get; } = new();
    }

    public static class FloatExtensions
    {
        public static float Clamp(this float value, float min, float max) => Math.Clamp(value, min, max);
        public static float Lerp(this float start, float end, float amount) => start + (end - start) * amount.Clamp(0f, 1f);
    }
}

namespace Localization
{
    public sealed class LanguageManager
    {
        public string GetLocalizedName(string key) => key;
    }
}

namespace Settings.Managers
{
    public static class SettingsManager
    {
        public static Settings.Data.SettingsData CurrentSettings { get; } = new();
    }
}

namespace Gameplay.Data
{
    public sealed class SlideEnterAreaData
    {
        public int area;
        public float timeRate;
    }

    public sealed class SlidePathData
    {
        public SlideEnterAreaData[] enterAreaData = [];
        public float Length;
    }
}

namespace Global.Chart
{
    public class NoteData
    {
        public TimeData hitTime;
    }

    public class TapData : NoteData
    {
        public int button;
        public bool isEx;
    }

    public sealed class HoldData : TapData
    {
        public TimeData holdTime;
    }

    public class TouchData : NoteData
    {
        public string button = "";
    }

    public sealed class TouchHoldData : TouchData
    {
        public TimeData holdTime;
    }

    public sealed class SlideFragmentData
    {
        public int endButton;
        public float Length;
        public SlidePathData Path = new();
    }

    public sealed class SlidePartData
    {
        public TimeData prepareTime;
        public TimeData moveTime;
        public bool isWifi;
        public bool IgnoreEnd;
        public List<SlideFragmentData> fragments = [];
        public float Length;
    }

    public sealed class SlideData : TapData
    {
        public List<SlidePartData> parts = [];
        public bool hindHead;
    }

    public sealed class NotesData
    {
        public BpmData bpmList = new();
        public List<TapData> taps = [];
        public List<HoldData> holds = [];
        public List<SlideData> slides = [];
        public List<TouchData> touches = [];
        public List<TouchHoldData> toucheHolds = [];
    }
}

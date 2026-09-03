using Fixture.Library;

namespace Fixture.App;

/// <summary>使用被引用 Library 项目的目标服务。</summary>
public static class TargetService
{
    public static int Value() => MathDependency.DoubleValue(21);
}

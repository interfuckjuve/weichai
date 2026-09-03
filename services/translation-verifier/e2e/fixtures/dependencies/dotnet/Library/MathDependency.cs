namespace Fixture.Library;

/// <summary>被 App 通过 ProjectReference 引用的确定性数学工具。</summary>
public static class MathDependency
{
    public static int DoubleValue(int value) => value * 2;
}

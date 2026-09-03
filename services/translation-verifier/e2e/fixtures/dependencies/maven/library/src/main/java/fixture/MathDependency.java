package fixture;

/** 本地 reactor 依赖:sibling module 提供的确定性数学工具。 */
public final class MathDependency {

    private MathDependency() {
    }

    public static int doubleValue(int value) {
        return value * 2;
    }
}

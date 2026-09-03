package fixture;

/** 使用 sibling reactor 模块 fixture:library 的目标服务。 */
public final class TargetService {

    private TargetService() {
    }

    public int value() {
        return MathDependency.doubleValue(21);
    }
}

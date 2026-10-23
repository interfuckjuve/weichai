using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(args[0]));
if (args[1] == "--smoke")
{
    var main = assembly.GetType("AssetUpgradeGateway.Program")?.GetMethod("Main", BindingFlags.Public | BindingFlags.Static);
    if (main == null || main.GetParameters().Length != 0) throw new InvalidOperationException("A public parameterless Program.Main is required.");
    var result = main.Invoke(null, null);
    if (result is Task task) await task;
    return;
}

string TypeName(Type type)
{
    if (type.IsByRef) return TypeName(type.GetElementType()!) + "&";
    if (type.IsArray) return TypeName(type.GetElementType()!) + "[" + new string(',', type.GetArrayRank() - 1) + "]";
    if (type.IsGenericParameter) return type.Name;
    if (type.IsGenericType)
    {
        var arguments = type.GetGenericArguments();
        var offset = 0;
        return string.Join(".", type.GetGenericTypeDefinition().FullName!.Split('+').Select(part =>
        {
            var marker = part.IndexOf('`');
            if (marker < 0) return part;
            var count = int.Parse(part[(marker + 1)..]);
            var result = part[..marker] + "<" + string.Join(",", arguments.Skip(offset).Take(count).Select(TypeName)) + ">";
            offset += count;
            return result;
        }));
    }
    return type.FullName ?? type.Name;
}

var signatures = new List<string>();
var members = new List<object>();
foreach (var type in assembly.GetExportedTypes().OrderBy(type => type.FullName, StringComparer.Ordinal))
{
    var owner = type.FullName!.Replace('+', '.');
    signatures.Add("type:" + owner);
    foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
        signatures.Add(owner + "#field:" + field.Name + ":" + TypeName(field.FieldType) + (field.IsStatic ? ":static" : ""));
    foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly).Cast<MethodBase>()
        .Concat(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)))
    {
        var parameters = string.Join(",", method.GetParameters().Select(parameter => TypeName(parameter.ParameterType)));
        var returnType = method is MethodInfo info ? TypeName(info.ReturnType) : "System.Void";
        var arity = method.IsGenericMethod ? "``" + method.GetGenericArguments().Length : "";
        var identity = owner + "#" + method.Name + arity + "(" + parameters + "):" + returnType + (method.IsStatic ? ":static" : "");
        signatures.Add(identity);
        var property = method.IsSpecialName && (method.Name.StartsWith("get_") || method.Name.StartsWith("set_"));
        if (method.IsSpecialName && !property && !method.IsConstructor) continue;
        var name = property ? method.Name[4..] : method.IsConstructor ? type.Name.Split('`')[0] : method.Name;
        members.Add(new { owner, name, parameters, constructor = method.IsConstructor, property, abstractMethod = method.IsAbstract,
            generic = type.ContainsGenericParameters || method.IsGenericMethod, identity });
    }
}
await File.WriteAllTextAsync(args[1], JsonSerializer.Serialize(new { signatures = signatures.OrderBy(value => value, StringComparer.Ordinal), members }));

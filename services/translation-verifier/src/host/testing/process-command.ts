import { join } from "node:path";

export function targetProcessCommand(executable: string, args: readonly string[]): { executable: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$|(?:^|[\\/])(?:mvn|mvnw|gradle|gradlew|npm|npx|yarn|pnpm)$/i.test(executable)) {
    return { executable, args: [...args] };
  }
  if ([executable, ...args].some(value => /[\0\r\n]/.test(value))) {
    throw new Error("Windows batch commands cannot contain NUL or line breaks.");
  }
  const escapeMeta = (value: string) => value.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
  const argument = (value: string) => escapeMeta(`"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`);
  const command = [escapeMeta(executable.replaceAll("/", "\\")), ...args.map(argument)].join(" ");
  return {
    executable: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/s", "/v:off", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

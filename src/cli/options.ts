export const CLI_VERSION = "1.0.0";

export const CLI_USAGE = `god-agent - 单 Agent Runtime CLI

Usage:
  god-agent [options]

Options:
  --debug    显示 Runtime、Model、Tool 等内部调试日志
  --help     显示命令行帮助
  --version  显示版本

进入交互会话后输入 /help 查看会话命令。`;

export interface CliOptions {
  debug: boolean;
  help: boolean;
  version: boolean;
}

export function parseCliOptions(
  arguments_: readonly string[],
): CliOptions {
  const options: CliOptions = {
    debug: false,
    help: false,
    version: false,
  };

  for (const argument of arguments_) {
    if (argument === "--debug") {
      options.debug = true;
      continue;
    }

    if (argument === "--help") {
      options.help = true;
      continue;
    }

    if (argument === "--version") {
      options.version = true;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

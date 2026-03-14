import * as vscode from "vscode";
import { TypingDemoController } from "./controller/typingDemoController";

let controller: TypingDemoController | undefined;

// 扩展激活时只负责创建控制器，具体逻辑全部下沉到 controller。
export function activate(context: vscode.ExtensionContext): void {
  controller = new TypingDemoController(context);
}

export async function deactivate(): Promise<void> {
  if (!controller) {
    return;
  }

  await controller.dispose();
  controller = undefined;
}

/**
 * Turn 运行期间的新消息先进入 FIFO；Runtime 保持单 Agent 串行执行。
 */
export class CliMessageQueue {
  private readonly messages: string[] = [];

  get size(): number {
    return this.messages.length;
  }

  enqueue(message: string): number {
    if (message.trim().length === 0) {
      throw new Error("Queued message must not be empty");
    }

    this.messages.push(message);
    return this.messages.length;
  }

  dequeue(): string | undefined {
    return this.messages.shift();
  }

  clear(): number {
    const removed = this.messages.length;
    this.messages.length = 0;
    return removed;
  }
}

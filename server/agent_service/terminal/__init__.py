"""
用户端 Terminal 命令执行能力服务层（issue #415）。

把前端下发的一条 bash 命令经 Gateway（TerminalDriver + TerminalExecutor）执行，
归一事件流经 SSE 流回前端：command_started -> command_output -> completed/error/cancelled。
"""

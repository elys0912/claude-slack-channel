// Windows に付属する実行ファイルの絶対パス。
// ブリッジのカレントディレクトリは作業フォルダー（信頼できないリポジトリのこともある）で、Windows は裸の名前の実行ファイルを
// PATH より先にカレントディレクトリから探しうる。同じ名前の実行ファイルが置かれていても、それを起動しないようにする
import path from 'node:path';

/** %SystemRoot%\System32 の下の実行ファイル（例: systemExe('tasklist.exe') → C:\Windows\System32\tasklist.exe） */
export function systemExe(...segments: string[]): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...segments);
}

/** Windows PowerShell 5.1（powershell.exe）の絶対パス */
export function powershellExe(): string {
  return systemExe('WindowsPowerShell', 'v1.0', 'powershell.exe');
}

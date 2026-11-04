// ターミナル画面のテスト用の写し（screen-relay / app のテストで共用）

/**
 * Claude in Chrome の案内の選択画面のうち、見出しと 3 つの選択肢の行だけ。カーソルは 2 つ目（Not now）にある。
 * 前後の出力を含む全体は screen.test.ts の CHROME_SCREEN。
 */
export const CHROME_CHOICE_SCREEN = [
  ' Claude wants to use your browser',
  '    Install extension  Opens the install page in Chrome',
  '  > Not now            Continue without browser tools',
  "    Don't ask again    Revisit anytime with /chrome",
].join('\n');

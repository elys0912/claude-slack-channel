// eslint の設定（flat config）。型情報を使う推奨ルールは tsconfig の対象（src / scripts / test の .ts）にだけ適用する。
// それ以外の JS / TS（tsconfig 外に置かれたスクリプトなど）は型情報なしのルールだけ当てる
// （型情報付きのルールを tsconfig 外のファイルに当てると、そのファイル 1 つで lint 全体が止まる）
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** tsconfig.test.json の対象 */
const TYPED_FILES = ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'];

export default tseslint.config(
  // .local/ は git 管理外のローカル用メモ・スパイク置き場（型情報の対象外なので lint しない）
  { ignores: ['dist/**', 'node_modules/**', '.local/**', 'eslint.config.js', 'vitest.config.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: TYPED_FILES })),
  {
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `void promise` で捨てる書き方を使っている（投げないことを呼び出し側で保証している）
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Slack の payload など外から来る値は unknown で受けて絞っている
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // テストでは型の都合で as を使う箇所がある
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/require-await': 'off',
      // vi.spyOn(obj, 'method') の形と、偽物の API が Slack 風のエラー値を投げる書き方を使う
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/only-throw-error': 'off',
    },
  }
);

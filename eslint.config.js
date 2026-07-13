// eslint の設定（flat config）。型情報を使う推奨ルールを src / scripts / test に適用する
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js', 'vitest.config.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
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

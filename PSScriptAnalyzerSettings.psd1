# CI の PSScriptAnalyzer（.github/workflows/ci.yml の scripts ジョブ）の設定
@{
    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        # コンソールに案内を出す起動スクリプトなので、Write-Host は意図どおり
        'PSAvoidUsingWriteHost',
        # 関数名の単数・複数と動詞の種類は見た目だけの指摘
        'PSUseSingularNouns',
        'PSUseApprovedVerbs',
        # スクリプトの param を中の関数から使うと、未使用と誤って判定される
        'PSReviewUnusedParameter',
        # New-ClaudeArgs などは一時ファイルを書くだけで、-WhatIf を付ける対象でない
        'PSUseShouldProcessForStateChangingFunctions'
    )
}

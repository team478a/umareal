# 紹介URLのLP引き継ぎ

会員が共有する紹介URLは本番では `https://umareal.com/?invite=紹介コード` とする。LPは `invite` を表示せず、安全な形式だけを無料会員登録画面へ引き継ぐ。

現在のLP末尾にある登録先設定を次のコードへ置き換える。

```html
<script>
const LINE_REGISTRATION_URL = 'https://lin.ee/xrI32VJ';
const EMAIL_REGISTRATION_URL = 'https://app.umareal.com/register';
const MEMBER_REFERRAL_CODE_PATTERN = /^[A-Z0-9_-]{8,32}$/i;

const invite = new URLSearchParams(window.location.search).get('invite');
const referralRegistrationUrl = new URL(EMAIL_REGISTRATION_URL);
const hasValidInvite = Boolean(invite && MEMBER_REFERRAL_CODE_PATTERN.test(invite));

if (hasValidInvite) {
  referralRegistrationUrl.searchParams.set('invite', invite.toUpperCase());
}

document.querySelectorAll('[data-register-link]').forEach((link) => {
  link.setAttribute('href', hasValidInvite ? referralRegistrationUrl.toString() : LINE_REGISTRATION_URL);
});
document.querySelectorAll('[data-email-register-link]').forEach((link) => {
  link.setAttribute('href', referralRegistrationUrl.toString());
});
</script>
```

紹介コード付きLPでは、LINEの主ボタンもアプリの登録方法選択画面へ進める。そこでLINE登録を選ぶと、既存OAuth flowが紹介コードを引き継ぐ。紹介コードがない通常のLP訪問では、現在のLINE友だち追加リンクを維持する。メール登録リンクも同じ紹介コードを引き継ぐ。

本番反映前に次を確認する。

1. `https://umareal.com/?invite=AB12CD34EF` を開く。
2. LINEとメールの両ボタンが `https://app.umareal.com/register?invite=AB12CD34EF` へ進むことを確認する。
3. 紹介コードなしの `https://umareal.com/` では、LINEボタンが従来の `https://lin.ee/xrI32VJ`、メールボタンが `https://app.umareal.com/register` のままであることを確認する。
4. 改ざんされたコードや33文字以上の値を登録リンクへ渡さないことを確認する。

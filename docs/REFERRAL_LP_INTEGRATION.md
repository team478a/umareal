# 紹介URLのLP引き継ぎ

会員が共有する紹介URLは本番では `https://umareal.com/?invite=紹介コード` とする。LPは `invite` を表示せず、安全な形式だけを無料会員登録画面へ引き継ぐ。

現在のLP末尾にある登録先設定を次のコードへ置き換える。

```html
<script>
const SYSTEM_REGISTRATION_URL = 'https://app.umareal.com/register';
const MEMBER_REFERRAL_CODE_PATTERN = /^[A-Z0-9_-]{8,32}$/i;

const invite = new URLSearchParams(window.location.search).get('invite');
const lineRegistrationUrl = new URL(SYSTEM_REGISTRATION_URL);
const emailRegistrationUrl = new URL(SYSTEM_REGISTRATION_URL);
const hasValidInvite = Boolean(invite && MEMBER_REFERRAL_CODE_PATTERN.test(invite));

lineRegistrationUrl.searchParams.set('entry', 'line');
if (hasValidInvite) {
  lineRegistrationUrl.searchParams.set('invite', invite.toUpperCase());
  emailRegistrationUrl.searchParams.set('invite', invite.toUpperCase());
}

document.querySelectorAll('[data-register-link]').forEach((link) => {
  link.setAttribute('href', lineRegistrationUrl.toString());
});
document.querySelectorAll('[data-email-register-link]').forEach((link) => {
  link.setAttribute('href', emailRegistrationUrl.toString());
});
</script>
```

LINEの主ボタンは、紹介コードの有無にかかわらず `entry=line` 付きのアプリ入口へ進める。アプリは登録方法選択画面を表示せずLINE OAuthを開始し、公式LINEの友だち状態を確認できた場合だけ、表示名・成人確認・規約同意を行う最後のシステム会員登録画面を表示する。メール登録リンクは従来どおり登録方法選択画面へ進み、紹介コードがある場合は同じコードを引き継ぐ。

本番反映前に次を確認する。

1. `https://umareal.com/?invite=AB12CD34EF` を開く。
2. LINEボタンが `https://app.umareal.com/register?entry=line&invite=AB12CD34EF`、メールボタンが `https://app.umareal.com/register?invite=AB12CD34EF` へ進むことを確認する。クエリパラメータの順序は問わない。
3. 紹介コードなしの `https://umareal.com/` では、LINEボタンが `https://app.umareal.com/register?entry=line`、メールボタンが `https://app.umareal.com/register` へ進むことを確認する。
4. 改ざんされたコードや33文字以上の値を登録リンクへ渡さないことを確認する。
5. LINEボタンから、LINE認証・友だち追加、最後のシステム会員登録の順で進み、登録方法選択画面が途中に表示されないことを確認する。

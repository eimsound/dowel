// 端到端测试用的本地 OIDC 提供方：固定返回同一个已授权用户，供“用 XX 账户接受邀请”流程使用。
// 由 playwright.config.ts 的 webServer 一起启动（端口 4652）。
import { Events, OAuth2Server } from 'oauth2-mock-server';

const server = new OAuth2Server();
await server.issuer.keys.generate('RS256');

const claims = {
  sub: 'e2e-oidc-subject',
  preferred_username: 'oidcuser',
  name: 'OIDC 用户',
  email: 'oidc@example.com',
};
server.service.on(Events.BeforeTokenSigning, (token) => {
  Object.assign(token.payload, claims);
});
server.service.on(Events.BeforeUserinfo, (res) => {
  Object.assign(res.body as Record<string, unknown>, claims);
});

await server.start(4652, 'localhost');
console.log(`OIDC 测试提供方：${server.issuer.url}`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

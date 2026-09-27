const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  return {
    ok: true,
    message: 'cloud function ping is reachable',
    openid: OPENID,
    serverTime: new Date().toISOString()
  };
};

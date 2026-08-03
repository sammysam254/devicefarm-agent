'use strict';

exports.handler = async (event) => {
  return {
    statusCode: 302,
    headers: {
      'Location': '/DeviceFarm-Desktop-Agent.zip',
    },
  };
};

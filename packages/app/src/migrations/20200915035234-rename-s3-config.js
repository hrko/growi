import { getMongoUri, mongoOptions } from '@growi/core';
import loggerFactory from '~/utils/logger';

import Config from '~/server/models/config';

const logger = loggerFactory('growi:migrate:remove-timeline-type');

const mongoose = require('mongoose');

const awsConfigs = [
  {
    oldValue: 'aws:bucket',
    newValue: 'aws:s3Bucket',
  },
  {
    oldValue: 'aws:region',
    newValue: 'aws:s3Region',
  },
  {
    oldValue: 'aws:accessKeyId',
    newValue: 'aws:s3AccessKeyId',
  },
  {
    oldValue: 'aws:secretAccessKey',
    newValue: 'aws:s3SecretAccessKey',
  },
  {
    oldValue: 'aws:customEndpoint',
    newValue: 'aws:s3CustomEndpoint',
  },
];

module.exports = {
  async up(db, client) {
    logger.info('Apply migration');
    mongoose.connect(getMongoUri(), mongoOptions);

    const request = awsConfigs.map((awsConfig) => {
      return {
        updateOne: {
          filter: { key: awsConfig.oldValue },
          update:  { key: awsConfig.newValue },
        },
      };
    });

    await Config.bulkWrite(request);

    logger.info('Migration has successfully applied');
  },

  async down(db, client) {
    logger.info('Rollback migration');

    mongoose.connect(getMongoUri(), mongoOptions);

    const request = awsConfigs.map((awsConfig) => {
      return {
        updateOne: {
          filter: { key: awsConfig.newValue },
          update:  { key: awsConfig.oldValue },
        },
      };
    });

    await Config.bulkWrite(request);
    logger.info('Migration has been successfully rollbacked');
  },
};

import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useTranslation } from 'react-i18next';
import { defaultSupportedCommandsNameForBroadcastUse, defaultSupportedCommandsNameForSingleUse } from '@growi/slack';
import loggerFactory from '~/utils/logger';

import { toastSuccess, toastError } from '../../../client/util/apiNotification';

const logger = loggerFactory('growi:SlackIntegration:ManageCommandsProcess');

// TODO: Add permittedChannelsForEachCommand to use data from server (props must have it) GW-7006
const ManageCommandsProcess = ({
  apiv3Put, slackAppIntegrationId, supportedCommandsForBroadcastUse, supportedCommandsForSingleUse,
}) => {
  const { t } = useTranslation();
  const [selectedCommandsForBroadcastUse, setSelectedCommandsForBroadcastUse] = useState(new Set(supportedCommandsForBroadcastUse));
  const [selectedCommandsForSingleUse, setSelectedCommandsForSingleUse] = useState(new Set(supportedCommandsForSingleUse));
  // TODO: Use data from server GW-7006
  const [permittedChannelsForEachCommand, setPermittedChannelsForEachCommand] = useState({
    channelsObject: {},
  });

  const toggleCheckboxForBroadcastUse = (e) => {
    const { target } = e;
    const { name, checked } = target;

    setSelectedCommandsForBroadcastUse((prevState) => {
      const selectedCommands = new Set(prevState);
      if (checked) {
        selectedCommands.add(name);
      }
      else {
        selectedCommands.delete(name);
      }

      return selectedCommands;
    });
  };

  const toggleCheckboxForSingleUse = (e) => {
    const { target } = e;
    const { name, checked } = target;

    setSelectedCommandsForSingleUse((prevState) => {
      const selectedCommands = new Set(prevState);
      if (checked) {
        selectedCommands.add(name);
      }
      else {
        selectedCommands.delete(name);
      }

      return selectedCommands;
    });
  };

  const updateCommandsHandler = async() => {
    try {
      await apiv3Put(`/slack-integration-settings/${slackAppIntegrationId}/supported-commands`, {
        supportedCommandsForBroadcastUse: Array.from(selectedCommandsForBroadcastUse),
        supportedCommandsForSingleUse: Array.from(selectedCommandsForSingleUse),
      });
      toastSuccess(t('toaster.update_successed', { target: 'Token' }));
    }
    catch (err) {
      toastError(err);
      logger.error(err);
    }
  };

  const updatePermittedChannelsForEachCommand = (e) => {
    const commandName = e.target.name;
    const allowedChannelsString = e.target.value;
    // remove all whitespace
    const spaceRemovedAllowedChannelsString = allowedChannelsString.replace(/\s+/g, '');
    // string to array
    const allowedChannelsArray = spaceRemovedAllowedChannelsString.split(',');
    setPermittedChannelsForEachCommand((prevState) => {
      const channelsObject = prevState.channelsObject;
      channelsObject[commandName] = allowedChannelsArray;
      prevState.channelsObject = channelsObject;
      return prevState;
    });
  };


  return (
    <div className="py-4 px-5">
      <p className="mb-4 font-weight-bold">{t('admin:slack_integration.accordion.manage_commands')}</p>
      <div className="row d-flex flex-column align-items-center">

        <div className="col-md-6">
          <p className="font-weight-bold mb-0">Multiple GROWI</p>
          <p className="text-muted mb-2">{t('admin:slack_integration.accordion.multiple_growi_command')}</p>
          <div className="pl-5 custom-control custom-checkbox">
            <div className="row mb-5 d-block">
              {defaultSupportedCommandsNameForBroadcastUse.map((commandName) => {

                let hiddenClass = '';
                if (selectedCommandsForBroadcastUse.has(commandName)) {
                  hiddenClass = 'd-none';
                }

                const allowedChannels = permittedChannelsForEachCommand.channelsObject[commandName];
                let defaultAllowedChannels;
                if (allowedChannels) {
                  defaultAllowedChannels = permittedChannelsForEachCommand.channelsObject[commandName].join();
                }
                else {
                  defaultAllowedChannels = '';
                }

                return (
                  <div className="row-6 my-1" key={commandName}>
                    <div className="row-6 my-3">
                      <input
                        type="checkbox"
                        className="custom-control-input"
                        id={commandName}
                        name={commandName}
                        value={commandName}
                        checked={selectedCommandsForBroadcastUse.has(commandName)}
                        onChange={toggleCheckboxForBroadcastUse}
                      />
                      <label className="text-capitalize custom-control-label ml-3" htmlFor={commandName}>
                        {commandName}
                      </label>
                    </div>
                    <div className={`row-12 row-md-6 ${hiddenClass}`}>
                      <textarea
                        className="form-control"
                        type="textarea"
                        name={commandName}
                        defaultValue={defaultAllowedChannels}
                        onChange={updatePermittedChannelsForEachCommand}
                      />
                      <p className="form-text text-muted small">
                        {t('admin:slack_integration.accordion.allowed_channels_description', { commandName })}
                        <br />
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="font-weight-bold mb-0 mt-4">Single GROWI</p>
          <p className="text-muted mb-2">{t('admin:slack_integration.accordion.single_growi_command')}</p>
          <div className="pl-5 custom-control custom-checkbox">
            <div className="row mb-5 d-block">
              {['create', 'togetter'].map((commandName) => {

                let hiddenClass = '';
                if (selectedCommandsForSingleUse.has(commandName)) {
                  hiddenClass = 'd-none';
                }

                const allowedChannels = permittedChannelsForEachCommand.channelsObject[commandName];
                let defaultAllowedChannels;
                if (allowedChannels) {
                  defaultAllowedChannels = permittedChannelsForEachCommand.channelsObject[commandName].join();
                }
                else {
                  defaultAllowedChannels = '';
                }

                return (
                  <div className="row-6 my-1 mb-2" key={commandName}>
                    <div className="row-6 my-3">
                      <input
                        type="checkbox"
                        className="custom-control-input"
                        id={commandName}
                        name={commandName}
                        value={commandName}
                        checked={selectedCommandsForSingleUse.has(commandName)}
                        onChange={toggleCheckboxForSingleUse}
                      />
                      <label className="text-capitalize custom-control-label ml-3" htmlFor={commandName}>
                        {commandName}
                      </label>
                    </div>
                    <div className={`row-12 row-md-6 ${hiddenClass}`}>
                      <textarea
                        className="form-control"
                        type="textarea"
                        name={commandName}
                        defaultValue={defaultAllowedChannels}
                        onChange={updatePermittedChannelsForEachCommand}
                      />
                      <p className="form-text text-muted small">
                        {t('admin:slack_integration.accordion.allowed_channels_description', { commandName })}
                        <br />
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary mx-auto"
          onClick={updateCommandsHandler}
        >
          { t('Update') }
        </button>
      </div>
    </div>
  );
};

ManageCommandsProcess.propTypes = {
  apiv3Put: PropTypes.func,
  slackAppIntegrationId: PropTypes.string.isRequired,
  supportedCommandsForBroadcastUse: PropTypes.arrayOf(PropTypes.string),
  supportedCommandsForSingleUse: PropTypes.arrayOf(PropTypes.string),
  // TODO: validate props originally from SlackIntegration.jsx. Use PropTypes.shape() maybe GW-7006
  // permittedChannelsForEachCommand: PropTypes.object.isRequired,
};

export default ManageCommandsProcess;

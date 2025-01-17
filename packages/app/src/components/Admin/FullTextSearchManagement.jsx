import React, { Fragment } from 'react';
import PropTypes from 'prop-types';
import { withTranslation } from 'react-i18next';

import { withUnstatedContainers } from '../UnstatedUtils';
import AppContainer from '~/client/services/AppContainer';

import ElasticsearchManagement from './ElasticsearchManagement/ElasticsearchManagement';


class FullTextSearchManagement extends React.Component {

  render() {
    const { t } = this.props;

    return (
      <div data-testid="admin-full-text-search">
        <h2> { t('full_text_search_management.elasticsearch_management') } </h2>
        <ElasticsearchManagement />
      </div>
    );
  }

}

const FullTextSearchManagementWrapper = withUnstatedContainers(FullTextSearchManagement, [AppContainer]);

FullTextSearchManagement.propTypes = {
  t: PropTypes.func.isRequired, // i18next
  appContainer: PropTypes.instanceOf(AppContainer).isRequired,
};

export default withTranslation()(FullTextSearchManagementWrapper);

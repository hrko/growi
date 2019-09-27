import React from 'react';
import PropTypes from 'prop-types';
import { withTranslation } from 'react-i18next';

import Modal from 'react-bootstrap/es/Modal';
import Button from 'react-bootstrap/es/Button';

import { createSubscribedElement } from '../../UnstatedUtils';
import AppContainer from '../../../services/AppContainer';

class ConfirmationPasswordModal extends React.Component {

  renderCreatedEmail(userList) {
    return (
      <ul>
        {userList.map((user) => {
          return (
            <li key={user.email}>Email: <strong className="mr-3">{user.email}</strong> Password: <strong>{user.password}</strong></li>
          );
        })}
      </ul>
    );
  }

  renderExistingEmail(emailList) {
    return (
      <>
        <p className="text-warning">以下のEmailはすでに存在しています</p>
        <ul>
          {emailList.map((user) => {
            return (
              <li key={user}><strong>{user}</strong></li>
            );
          })}
        </ul>
      </>
    );
  }

  render() {
    const { t } = this.props;
    const { createdUserList, existingEmailList } = this.props.invitedEmailList;

    return (
      <Modal show={this.props.show}>
        <Modal.Header className="modal-header" closeButton>
          <Modal.Title>
            { t('user_management.invited') }
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>{ t('user_management.temporary_password') }</p>
          <p>{ t('user_management.send_new_password') }</p>
          <p className="text-danger">{ t('user_management.send_temporary_password') }</p>
          {createdUserList && this.renderCreatedEmail(createdUserList)}
          {existingEmailList && this.renderExistingEmail(existingEmailList)}
        </Modal.Body>
        <Modal.Footer>
          <Button
            bsStyle="primary"
            className="fcbtn btn btn-primary btn-outline btn-rounded btn-1b"
            onClick={this.props.closeConfirmationPasswordModal}
          >
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

}

/**
 * Wrapper component for using unstated
 */
const ConfirmationPasswordModalWrapper = (props) => {
  return createSubscribedElement(ConfirmationPasswordModal, props, [AppContainer]);
};


ConfirmationPasswordModal.propTypes = {
  t: PropTypes.func.isRequired, // i18next
  appContainer: PropTypes.instanceOf(AppContainer).isRequired,

  show: PropTypes.bool.isRequired,
  closeConfirmationPasswordModal: PropTypes.func.isRequired,
  invitedEmailList: PropTypes.object,
};

export default withTranslation()(ConfirmationPasswordModalWrapper);

context('Open Page Delete Modal Diagrams', () => {

  const ssPrefix = 'open-delete-modal-';

  let connectSid: string | undefined;

  before(() => {
    // login
    cy.fixture("user-admin.json").then(user => {
      cy.login(user.username, user.password);
    });
    cy.getCookie('connect.sid').then(cookie => {
      connectSid = cookie?.value;
    });
    // collapse sidebar
    cy.collapseSidebar(true);
  });

  beforeEach(() => {
    if (connectSid != null) {
      cy.setCookie('connect.sid', connectSid);
      cy.visit('/');
    }
  });

  it('PageDeleteModal is shown successfully', () => {
     cy.visit('/Sandbox/Diagrams', {  });
     cy.get('#grw-subnav-container').within(() => {
       cy.getByTestid('open-page-item-control-btn').click();
       cy.getByTestid('open-page-delete-modal-btn').click();
    });


     cy.screenshot(`${ssPrefix}-diagrams`,{ capture: 'viewport' });
  });

});


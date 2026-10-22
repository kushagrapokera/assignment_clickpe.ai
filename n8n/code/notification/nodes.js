/**
 * References to the other nodes of Workflow C.
 *
 * The names are injected by the build script from the workflow template, so
 * the code and the workflow cannot drift apart.
 */

const NODES = {
  /** Node that built the emails, it still holds the applicant of every mail. */
  sent: '__NODE__:sent',
};

module.exports = { NODES };

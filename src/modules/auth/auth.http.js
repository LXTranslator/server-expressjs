'use strict';

/**
 * HTTP translation shared by the password, second factor and provider
 * controllers.
 *
 * A session starts in four places: registering, a password sign in, a provider
 * sign in and an answered second factor challenge. All four answer with the
 * same body, so a client reads one shape however the person signed in.
 */

/**
 * Describes the client a session is being created for.
 *
 * The user agent is the only thing recorded, and only so a list of sessions is
 * actionable: "sign out the one I do not recognise" needs something to
 * recognise. The address the request came from is deliberately not stored. It
 * locates a person, it changes constantly, and it answers that question worse
 * than the device string does.
 *
 * @param {import('express').Request} req Request.
 * @returns {{userAgent: string|undefined}} Session context.
 */
function clientContext(req) {
  return { userAgent: req.get('user-agent') ?? undefined };
}

/**
 * The response data for a session that has just started.
 *
 * @param {{account: object, token: string, expiresIn: number}} session The
 *   account, its bearer token and the token lifetime in seconds.
 * @returns {object} Response data.
 */
function sessionData({ account, token, expiresIn }) {
  return {
    account: account.toPublicJson(),
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
  };
}

/**
 * Answers a sign in, which either starts a session or asks for the second
 * factor.
 *
 * @param {import('express').Response} res Response.
 * @param {object} result Sign in result from the password or provider service.
 * @returns {void}
 */
function sendSignIn(res, result) {
  if (result.mfaRequired) {
    /*
     * 200 rather than 401. The credentials were correct, and a 401 is what
     * every client treats as "this session is over". Answering one here would
     * have the client discard the challenge it was just handed.
     *
     * The account is deliberately absent. `toPublicJson` carries the email
     * address, and returning it now would hand that address to anybody holding
     * the password, before the second factor has proved anything.
     */
    res.json({
      data: {
        mfa_required: true,
        challenge_token: result.challengeToken,
        expires_in: result.expiresIn,
      },
    });
    return;
  }

  res.json({ data: sessionData(result) });
}

module.exports = { clientContext, sessionData, sendSignIn };

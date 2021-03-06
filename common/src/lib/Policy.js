/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// This code is based on fabric-client v2.0.0-beta.2 in https://github.com/hyperledger/fabric-sdk-node.

'use strict';

const fabprotos = require('fabric-protos');
const util = require('util');

const IDENTITY_TYPE = {
	Role: 'role',
	OrganizationUnit: 'organization-unit',
	Identity: 'identity'
};

/**
 * @typedef {Object} Policy Defines the endorsement policies
 * @property {Identity[]} identities List of identities to be referenced in the "policy" section
 * @property {PolicySpec[]} policy The specification of the policy using a combination of "signed-by" and
 * "n-of" structures. The design allows recursion
 */

/**
 * @typedef {Object} Identity
 * @property {Role} role Any identity of a particular role
 * @property OrganizationUnit Any identities belonging to an organization unit per certificate chain of trust
 * @property Identity A specific identity
 */

/**
 * @typedef {Object} Role
 * @property {string} name Name of the role. Value can be "member" or "admin"
 * @property {string} mspId The member service provider Id used to process the identity
 */

/**
 * @typedef {Object} PolicySpec
 * @property {Object} type The type of policy can be "signed-by" for a single identity signature or "n-of"
 * where "n" is a numeric value. If the type property is "signed-by", the value is the numeric index into the
 * array of identities specified in the policy. If the type property is "n-of", the value is an array of
 * {@link PolicySpec} objects. As you can see, this structure allows recursive definitions of complex policies.
 */

/**
 * Governs the constructions of endorsement policies to be passed into the calls to instantiate chaincodes
 * @class
 */
const EndorsementPolicy = class {
	/**
	 * Constructs an endorsement policy envelope. If the optional "policy" object is not present, a default
	 * policy of "a signature by any member from any of the organizations corresponding to the array of member
	 * service providers" is returned.
	 *
	 * @param {MSP[]} msps Array of Member Service Provider objects representing the participants of the
	 * endorsement policy to be constructed
	 * @param {Policy} policy The policy specification. It has two high-level properties: identities and policy.
	 * see the type definition of {@link Policy} for details.
	 * @param {boolean} [returnProto] Optional. If the return value should be in bytes or protobuf.
	 */
	static buildPolicy(msps, policy, returnProto) {
		const principals = [];
		const envelope = new fabprotos.common.SignaturePolicyEnvelope();
		if (!policy) {
			// no policy was passed in, construct a 'Signed By any member of an organization by mspid' policy
			// construct a list of msp principals to select from using the 'n out of' operator
			const signedBys = [];
			let index = 0;
			for (const name in msps) {
				if (Object.prototype.hasOwnProperty.call(msps, name)) {
					const onePrn = new fabprotos.common.MSPPrincipal();
					onePrn.principal_classification = fabprotos.common.MSPPrincipal.Classification.ROLE;

					const memberRole = new fabprotos.common.MSPRole();
					memberRole.role = fabprotos.common.MSPRole.MSPRoleType.MEMBER;
					memberRole.msp_identifier = name;

					onePrn.principal = fabprotos.common.MSPRole.encode(memberRole).finish();

					principals.push(onePrn);

					const signedBy = new fabprotos.common.SignaturePolicy();
					signedBy.signed_by = index++;
					signedBys.push(signedBy);
				}
			}

			if (principals.length === 0) {
				throw new Error('Verifying MSPs not found in the channel object, make sure "initialize()" is called first.');
			}

			// construct 'one of any' policy
			const oneOfAny = new fabprotos.common.SignaturePolicy.NOutOf();
			oneOfAny.n = 1;
			oneOfAny.rules = signedBys;

			const noutof = new fabprotos.common.SignaturePolicy();
			noutof.n_out_of = oneOfAny;

			envelope.version = 0;
			envelope.rule = noutof;
			envelope.identities = principals;

			if (returnProto) {
				return envelope;
			}
			return fabprotos.common.SignaturePolicyEnvelope.encode(envelope).finish();
		} else {
			// check the structure of the policy object is legit
			checkPolicy(policy);

			policy.identities.forEach((identity) => {
				const newPrincipal = buildPrincipal(identity);
				principals.push(newPrincipal);
			});

			const thePolicy = parsePolicy(policy.policy);

			envelope.version = 0;
			envelope.rule = thePolicy
			envelope.identities = principals;

			if (returnProto) {
				return envelope;
			}
			return fabprotos.common.SignaturePolicyEnvelope.encode(envelope).finish();
		}
	}
};

function buildPrincipal(identity) {
	const principalType = getIdentityType(identity);
	const newPrincipal = new fabprotos.common.MSPPrincipal();

	if (principalType === IDENTITY_TYPE.Role) {
		newPrincipal.principal_classification = fabprotos.common.MSPPrincipal.Classification.ROLE;
		const newRole = new fabprotos.common.MSPRole();
		const roleName = identity[principalType].name;
		if (roleName === 'peer') {
			newRole.role = fabprotos.common.MSPRole.MSPRoleType.PEER;
		} else if (roleName === 'member') {
			newRole.role = fabprotos.common.MSPRole.MSPRoleType.MEMBER;
		} else if (roleName === 'admin') {
			newRole.role = fabprotos.common.MSPRole.MSPRoleType.ADMIN;
		} else {
			throw new Error(util.format('Invalid role name found: must be one of "peer", "member" or "admin", but found "%s"', roleName));
		}

		const mspid = identity[principalType].mspId;
		if (typeof mspid !== 'string' || !mspid) {
			throw new Error(util.format('Invalid mspid found: "%j"', mspid));
		}
		newRole.msp_identifier = mspid;

		newPrincipal.principal = fabprotos.common.MSPRole.encode(newRole).finish();
	} else {
		throw new Error('NOT IMPLEMENTED');
	}

	return newPrincipal;
}

function getIdentityType(obj) {
	const invalidTypes = [];
	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			if (key === IDENTITY_TYPE.Role || key === IDENTITY_TYPE.OrganizationUnit || key === IDENTITY_TYPE.Identity) {
				return key;
			} else {
				invalidTypes.push(key);
			}
		}
	}

	throw new Error(util.format(
		'Invalid identity type found: must be one of %s, %s or %s, but found %s',
		IDENTITY_TYPE.Role,
		IDENTITY_TYPE.OrganizationUnit,
		IDENTITY_TYPE.Identity,
		invalidTypes));
}

function getPolicyType(spec) {
	const invalidTypes = [];
	for (const key in spec) {
		if (Object.prototype.hasOwnProperty.call(spec, key)) {
			// each policy spec has exactly one property of one of these two forms: 'n-of' or 'signed-by'
			if (key === 'signed-by' || key.match(/^\d+-of$/)) {
				return key;
			} else {
				invalidTypes.push(key);
			}
		}
	}

	throw new Error(util.format('Invalid policy type found: must be one of "n-of" or "signed-by" but found "%s"', invalidTypes));
}

function parsePolicy(spec) {
	const type = getPolicyType(spec);
	if (type === 'signed-by') {
		const signedBy = new fabprotos.common.SignaturePolicy();
		signedBy.signed_by = spec[type];
		return signedBy;
	} else {
		const n = type.match(/^(\d+)-of$/)[1];
		const array = spec[type];

		const nOutOf = new fabprotos.common.SignaturePolicy.NOutOf();
		nOutOf.n = parseInt(n);

		const subs = [];
		array.forEach((sub) => {
			const subPolicy = parsePolicy(sub);
			subs.push(subPolicy);
		});

		nOutOf.rules = subs;

		const nOf = new fabprotos.common.SignaturePolicy();
		nOf.n_out_of = nOutOf;

		return nOf;
	}
}

function buildSignaturePolicy(spec) {
	const type = getPolicyType(spec);
	if (type === 'signed-by') {
		return {
			signed_by: spec[type]
		};
	} else {
		let n = type.match(/^(\d+)-of$/)[1];
		n = parseInt(n);
		const ruleArray = spec[type];
		const rules = [];
		ruleArray.forEach(rule => {
			rules.push(buildSignaturePolicy(rule));
		});
		const nOutOf = {
			n_out_of: {
				n,
				rules
			}
		};
		return nOutOf;
	}
}

function checkPolicy(policy) {
	if (!policy) {
		throw new Error('Missing Required Param "policy"');
	}
	if (!policy.identities || policy.identities === '' || Object.keys(policy.identities).length === 0) {
		throw new Error('Invalid policy, missing the "identities" property');
	} else if (!Array.isArray(policy.identities)) {
		throw new Error('Invalid policy, the "identities" property must be an array');
	}

	if (!policy.policy || policy.policy === '' || Object.keys(policy.policy).length === 0) {
		throw new Error('Invalid policy, missing the "policy" property');
	}
}

module.exports = EndorsementPolicy;
module.exports.IDENTITY_TYPE = IDENTITY_TYPE;
module.exports.buildPrincipal = buildPrincipal;
module.exports.buildSignaturePolicy = buildSignaturePolicy;
module.exports.checkPolicy = checkPolicy;

'use strict';

/**
 * OpenTimestamps module.
 * @module OpenTimestamps
 * @author EternityWall
 * @license LPGL3
 */

const Context = require('./context.js');
const DetachedTimestampFile = require('./detached-timestamp-file.js');
const Timestamp = require('./timestamp.js');
const Utils = require('./utils.js');
const Ops = require('./ops.js');
const Calendar = require('./calendar.js');
const Notary = require('./notary.js');
const Insight = require('./insight.js');

module.exports = {

  /**
   * Show information on a timestamp.
   * @exports OpenTimestamps/info
   * @param {ArrayBuffer} ots - The ots array buffer.
   */
  info(ots) {
    if (ots === undefined) {
      console.log('No ots file');
      return;
    }

    const ctx = new Context.StreamDeserialization();
    ctx.open(Utils.arrayToBytes(ots));
    const detachedTimestampFile = DetachedTimestampFile.DetachedTimestampFile.deserialize(ctx);

    const fileHash = Utils.bytesToHex(detachedTimestampFile.timestamp.msg);
    const hashOp = detachedTimestampFile.fileHashOp._HASHLIB_NAME();
    const firstLine = 'File ' + hashOp + ' hash: ' + fileHash + '\n';

    return firstLine + 'Timestamp:\n' + detachedTimestampFile.timestamp.strTree() + '\n';
  },

  /**
   * Create timestamp with the aid of a remote calendar. May be specified multiple times.
   * @exports OpenTimestamps/stamp
   * @param {ArrayBuffer} plain - The plain array buffer to stamp.
   */
  stamp(plain) {
    return new Promise((resolve, reject) => {
      const ctx = new Context.StreamDeserialization();
      ctx.open(Utils.arrayToBytes(plain));

      const fileTimestamp = DetachedTimestampFile.DetachedTimestampFile.fromBytes(new Ops.OpSHA256(), ctx);

          /* Add nonce

          # Remember that the files - and their timestamps - might get separated
          # later, so if we didn't use a nonce for every file, the timestamp
          # would leak information on the digests of adjacent files. */

      const bytesRandom16 = Utils.randBytes(16);

      // nonce_appended_stamp = file_timestamp.timestamp.ops.add(OpAppend(os.urandom(16)))
      const opAppend = new Ops.OpAppend(Utils.arrayToBytes(bytesRandom16));
      let nonceAppendedStamp = fileTimestamp.timestamp.ops.get(opAppend);
      if (nonceAppendedStamp === undefined) {
        nonceAppendedStamp = new Timestamp(opAppend.call(fileTimestamp.timestamp.msg));
        fileTimestamp.timestamp.ops.set(opAppend, nonceAppendedStamp);

        console.log(Timestamp.strTreeExtended(fileTimestamp.timestamp));
      }

      // merkle_root = nonce_appended_stamp.ops.add(OpSHA256())
      const opSHA256 = new Ops.OpSHA256();
      let merkleRoot = nonceAppendedStamp.ops.get(opSHA256);
      if (merkleRoot === undefined) {
        merkleRoot = new Timestamp(opSHA256.call(nonceAppendedStamp.msg));
        nonceAppendedStamp.ops.set(opSHA256, merkleRoot);

        console.log(Timestamp.strTreeExtended(fileTimestamp.timestamp));
      }

      console.log('fileTimestamp:');
      console.log(fileTimestamp.toString());

      console.log('merkleRoot:');
      console.log(merkleRoot.toString());

      // merkleTip  = make_merkle_tree(merkle_roots)
      const merkleTip = merkleRoot;

      const calendarUrls = [];
      // calendarUrls.push('https://alice.btc.calendar.opentimestamps.org');
      // calendarUrls.append('https://b.pool.opentimestamps.org');
      calendarUrls.push('https://ots.eternitywall.it');

      this.createTimestamp(merkleTip, calendarUrls).then(timestamp => {
        console.log('Result Timestamp:');
        console.log(Timestamp.strTreeExtended(timestamp));

        console.log('Complete Timestamp:');
        console.log(Timestamp.strTreeExtended(fileTimestamp.timestamp));

        // serialization
        const css = new Context.StreamSerialization();
        css.open();
        fileTimestamp.serialize(css);

        console.log('SERIALIZATION');
        console.log(Utils.bytesToHex(css.getOutput()));

        resolve(css.getOutput());
      }).catch(err => {
        reject(err);
      });
    });
  },

  /**
   * Create a timestamp
   * @param {timestamp} timestamp - The timestamp.
   * @param {string[]} calendarUrls - List of calendar's to use.
   */
  createTimestamp(timestamp, calendarUrls) {
    // setup_bitcoin : not used

    // const n = calendarUrls.length; // =1

    // only support 1 calendar
    const calendarUrl = calendarUrls[0];

    return new Promise((resolve, reject) => {
      console.log('Submitting to remote calendar ', calendarUrl);
      const remote = new Calendar.RemoteCalendar(calendarUrl);
      remote.submit(timestamp.msg).then(resultTimestamp => {
        timestamp.merge(resultTimestamp);

        resolve(timestamp);
      }, err => {
        console.log('Error: ' + err);

        reject(err);
      });
    });
  },

  /**
   * Verify a timestamp.
   * @exports OpenTimestamps/verify
   * @param {ArrayBuffer} ots - The ots array buffer containing the proof to verify.
   * @param {ArrayBuffer} plain - The plain array buffer to verify.
   */
  verify(ots, plain) {
    console.log('ots: ', ots);
    console.log('plain: ', plain);

    const ctx = new Context.StreamDeserialization();
    ctx.open(Utils.arrayToBytes(ots));

    const detachedTimestamp = DetachedTimestampFile.DetachedTimestampFile.deserialize(ctx);
    console.log('Hashing file, algorithm ' + detachedTimestamp.fileHashOp._TAG_NAME());

    const ctxHashfd = new Context.StreamDeserialization();
    ctxHashfd.open(Utils.arrayToBytes(plain));

    const actualFileDigest = detachedTimestamp.fileHashOp.hashFd(ctxHashfd);
    console.log('actualFileDigest ' + Utils.bytesToHex(actualFileDigest));
    console.log('detachedTimestamp.fileDigest() ' + Utils.bytesToHex(detachedTimestamp.fileDigest()));

    const detachedFileDigest = detachedTimestamp.fileDigest();
    if (!Utils.arrEq(actualFileDigest, detachedFileDigest)) {
      console.log('Expected digest ' + Utils.bytesToHex(detachedTimestamp.fileDigest()));
      console.log('File does not match original!');
      return;
    }
    console.log(Timestamp.strTreeExtended(detachedTimestamp.timestamp, 0));
    return this.verifyTimestamp(detachedTimestamp.timestamp);
  },

  /** Verify a timestamp.
   * @param {Timestamp} timestamp - The timestamp.
   * @return {boolean} True if the timestamp is verified, False otherwise.
   */
  verifyTimestamp(timestamp) {
    return new Promise((resolve, reject) => {
      // upgradeTimestamp(timestamp, args);

      for (const [msg, attestation] of timestamp.allAttestations()) {
        if (attestation instanceof Notary.PendingAttestation) {
          console.log('PendingAttestation: pass ');
        } else if (attestation instanceof Notary.BitcoinBlockHeaderAttestation) {
          console.log('Request to insight ');
          const url = 'https://search.bitaccess.co/insight-api';
            // https://search.bitaccess.co/insight-api
            // https://insight.bitpay.com/api
          const insight = new Insight.Insight(url);

          insight.blockindex(attestation.height).then(blockHash => {
            console.log('blockHash: ' + blockHash);

            insight.block(blockHash).then(merkleroot => {
              const merkle = Utils.hexToBytes(merkleroot);
              const message = msg.reverse();

              console.log('merkleroot: ' + Utils.bytesToHex(merkle));
              console.log('msg: ' + Utils.bytesToHex(message));

                // One Bitcoin attestation is enough
              if (Utils.arrEq(merkle, message)) {
                console.log('Equal');
                resolve(true);
              } else {
                console.log('Diff');
                resolve(false);
              }
            }, err => {
              console.log('Error: ' + err);
              reject(err);
            });
          });

          // Verify only the first BitcoinBlockHeaderAttestation
          return;
        }
      }
      resolve(false);
    });
  },

  /** Upgrade a timestamp.
   * @param {ArrayBuffer} ots - The ots array buffer containing the proof to verify.
   * @return {boolean} True if the timestamp has changed, False otherwise.
   */
  upgrade(ots) {
    console.log('ots: ', ots);

    const ctx = new Context.StreamDeserialization();
    ctx.open(Utils.arrayToBytes(ots));
    const detachedTimestampFile = DetachedTimestampFile.DetachedTimestampFile.deserialize(ctx);

    const changed = this.upgradeTimestamp(detachedTimestampFile.timestamp);

    if (changed) {
      console.log('Change timestamp');
    }

    if (detachedTimestampFile.timestamp.isTimestampComplete()) {
      console.log('Success! Timestamp complete');
    } else {
      console.log('Failed! Timestamp not complete');
    }
  },

  /** Attempt to upgrade an incomplete timestamp to make it verifiable.
   * Note that this means if the timestamp that is already complete, False will be returned as nothing has changed.
   * @param {Timestamp} timestamp - The timestamp.
   * @return {boolean} True if the timestamp has changed, False otherwise.
   */
  upgradeTimestamp(timestamp) {
    // Check remote calendars for upgrades.
    // This time we only check PendingAttestations - we can't be as agressive.

    const calendarUrls = [];
    // calendarUrls.push('https://alice.btc.calendar.opentimestamps.org');
    // calendarUrls.append('https://b.pool.opentimestamps.org');
    calendarUrls.push('https://ots.eternitywall.it');

    const existingAttestations = timestamp.getAttestations();
    // let foundNewAttestations = false;

    while (!timestamp.isTimestampComplete()) {
      console.log(timestamp.directlyVerified().length);
      for (const subStamp of timestamp.directlyVerified()) {
        for (const attestation of subStamp.attestations) {
          if (attestation instanceof Notary.PendingAttestation) {
            const calendarUrl = attestation.uri;
            // var calendarUrl = calendarUrls[0];
            const commitment = subStamp.msg;

            console.log('attestation url: ', calendarUrl);
            console.log('commitment: ', Utils.bytesToHex(commitment));

            const calendar = new Calendar.RemoteCalendar(calendarUrl);

            this.upgradeStamp(calendar, commitment, existingAttestations).then(upgradedStamp => {
              console.log(upgradedStamp);
              subStamp.merge(upgradedStamp);
            }).catch(err => {
              console.log(err);
            });

            return;
          }
        }
      }
    }

    console.log(Timestamp.strTreeExtended(timestamp, 0));
    return false;
  },

  upgradeStamp(calendar, commitment, existingAttestations) {
    return new Promise((resolve, reject) => {
      calendar.getTimestamp(commitment).then(upgradedStamp => {
        console.log(Timestamp.strTreeExtended(upgradedStamp, 0));

        // const atts_from_remote = get_attestations(upgradedStamp)
        const attsFromRemote = upgradedStamp.getAttestations();
        if (attsFromRemote.size > 0) {
          console.log(attsFromRemote.size + ' attestation(s) from ' + calendar.url);
        }

        // difference from remote attestations & existing attestations
        const newAttestations = new Set([...attsFromRemote].filter(x => !existingAttestations.has(x)));
        if (newAttestations.size > 0) {
          // changed & found_new_attestations
          // foundNewAttestations = true;
          console.log(attsFromRemote.size + ' attestation(s) from ' + calendar.url);

          // union of existingAttestations & newAttestations
          existingAttestations = new Set([...existingAttestations, ...newAttestations]);
          resolve(upgradedStamp);
          // subStamp.merge(upgradedStamp);
          // args.cache.merge(upgraded_stamp)
          // sub_stamp.merge(upgraded_stamp)
        } else {
          reject();
        }
      }).catch(err => {
        reject(err);
      });
    });
  }

};

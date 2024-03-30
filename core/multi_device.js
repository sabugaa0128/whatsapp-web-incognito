// 
// Noise & Signal protocol handling
//

var MultiDevice = {};

var originalImportKey = crypto.subtle.importKey;

MultiDevice.initialize = function()
{
    MultiDevice.readKey = null;
    MultiDevice.readKeyImported = null;
    MultiDevice.writeKey = null;
    MultiDevice.writeKeyImported = null;
    MultiDevice.readCounter = 0;
    MultiDevice.writeCounter = 0;
    MultiDevice.incomingQueue = new PromiseQueue();
    MultiDevice.outgoingQueue = new PromiseQueue();

    // install our hook in order to discover the Noise keys
    window.crypto.subtle.importKey = async function(format, keyData, algorithm, extractable, keyUsages)
    {
        if (format == "raw" && algorithm == "AES-GCM" && keyData.length == 32 && extractable == false && keyUsages.length == 1)
        {
            var key = await originalImportKey.apply(window.crypto.subtle, ["raw", new Uint8Array(keyData), algorithm, false, ["decrypt", "encrypt"]]);

            if (keyUsages.includes("encrypt"))
            {
                MultiDevice.writeKey = keyData;
                MultiDevice.writeCounter = 0;
                MultiDevice.writeKeyImported = key;
                console.log("WAIncognito: Noise encryption key has been replaced.");
            }
            else if (keyUsages.includes("decrypt"))
            {
                MultiDevice.readKey = keyData;
                MultiDevice.readKeyImported = key;
                MultiDevice.readCounter = 0;
                console.log("WAIncognito: Noise decryption key has been replaced.");
            }
        }

        return originalImportKey.call(window.crypto.subtle, format, keyData, algorithm, extractable, keyUsages);
    };
};

MultiDevice.decryptNoisePacket = async function(payload, isIncoming = true)
{    
    if (MultiDevice.looksLikeHandshakePacket(payload) || MultiDevice.readKey == null) return null;

    // split to frames
    var binaryReader = new BinaryReader();
    binaryReader.writeBuffer(payload);
    binaryReader._readIndex = 0;

    var frames = [];
    while (binaryReader._readIndex + 3 < payload.byteLength)
    {
        var size = binaryReader.readUint8() << 16 | binaryReader.readUint16();
        var frame = binaryReader.readBuffer(size);
        var counter = isIncoming ? MultiDevice.readCounter++ : MultiDevice.writeCounter++;
        var frameInfo = {frame: frame, counter: counter};

        frames.push(frameInfo);
    }

    try
    {
        for (var i = 0; i < frames.length; i++)
        {
            var frameInfo = frames[i];
    
            var currentFrame = frameInfo.frame;
            var counter = frameInfo.counter;
            
            var key = isIncoming ? MultiDevice.readKeyImported : MultiDevice.writeKeyImported;
            var algorithmInfo = {name: "AES-GCM", iv: MultiDevice.counterToIV(counter), additionalData: new ArrayBuffer(0)};
    
            var decryptedFrame = await window.crypto.subtle.decrypt(algorithmInfo, key, currentFrame);
            var flags = new Uint8Array(decryptedFrame)[0];
            var decryptedFrameOpened = decryptedFrame.slice(1);
            if (flags & 2)
            {
                // zlib compressed. decompress
                decryptedFrameOpened = toArrayBuffer(pako.inflate(new Uint8Array(decryptedFrameOpened)));
            }
    
            frames[i] = {frame: decryptedFrameOpened, counter: counter, frameUncompressed: decryptedFrame};  
        }
    }
    catch (exception)
    {
        if (exception.name.includes("OperationError"))
        {
            // reverse the counter, in case this is another socket
            if (isIncoming) MultiDevice.readCounter--;
            else MultiDevice.writeCounter--;

            throw "Wrong counter in decryption";
        }
        else
        {
            console.error("Could not decrypt Noise packet");
            console.error(exception);
            debugger;
            throw exception;
        }
    }

    return frames;
};

MultiDevice.encryptAndPackNodesForSending = async function(nodesInfo, isIncoming = false)
{
    // convert to binary protocol
    var packetBinaryWriter = new BinaryWriter();
    for (var i = 0; i < nodesInfo.length; i++)
    {
        var nodeInfo = nodesInfo[i];
        var node = nodeInfo.node;
        var counter = nodeInfo.counter;
        var decryptedFrame = nodeInfo.decryptedFrame;

        var nodeBuffer = await nodeReaderWriter.encodeStanza(node);

        // encrypt it
        var data = await MultiDevice.encryptPacket(nodeBuffer, isIncoming, counter);

        // Serialize to Noise protocol
        var binaryStream = new BinaryReader();
        
        var size = data.byteLength;
        binaryStream.writeUint8(size >> 16);
        binaryStream.writeUint16(65535 & size);
        binaryStream.write(data);

        binaryStream._readIndex = 0;
        var serializedPacket =  binaryStream.readBuffer();

        packetBinaryWriter.pushBytes(serializedPacket);
    }

    return packetBinaryWriter.toBuffer();
}

MultiDevice.encryptPacket = async function(payload, isIncoming = true, counter = 0)
{    
    var keyData = isIncoming ? MultiDevice.readKey : MultiDevice.writeKey;
    var key = isIncoming ? MultiDevice.readKeyImported : MultiDevice.writeKeyImported;

    var algorithmInfo = {name: "AES-GCM", iv: MultiDevice.counterToIV(counter), additionalData: new ArrayBuffer(0)};
    return window.crypto.subtle.encrypt(algorithmInfo, key, payload)
    .catch(function(e) {
        console.error(e);
        //debugger;
    });
    
};

MultiDevice.sizeOfPacket = function(payload)
{
    var binaryReader = new BinaryReader();
    binaryReader.writeBuffer(payload);
    binaryReader._readIndex = 0;

    var size = binaryReader.readUint8() << 16 | binaryReader.readUint16();
    return size;
};


MultiDevice.decryptE2EMessagesFromMessageNode = async function(messageNode)
{
    var remoteJid = messageNode.attrs["jid"] ? messageNode.attrs["jid"] : messageNode.attrs["from"];
    var participant = messageNode.attrs["participant"];
    var participantLid = messageNode.attrs["participant_lid"];

    var fromJid = participant ? participant : remoteJid;
    fromJid = fromJid.toString();

    var decryptedMessages = [];
    var keyDistributionMessage = null;

    // get the storage
    if (!window.WhatsAppAPI) exposeWhatsAppAPI();

    var storageModule = window.WhatsAppAPI.SignalStore;
    storage = storageModule.getSignalProtocolStore();
    if (storage == undefined) 
    {
        storageModule.enableMemSignalStore();
        storage = storageModule.getSignalProtocolStore();
    }

    var childMessages = messageNode.content;
    for (var message of childMessages)
    {
        if (message.tag != "enc") continue;

        var ciphertext = message.content;
        var chiphertextType = message.attrs["type"];

        // decrypt the message
        var address = fromJid.substring(0, fromJid.indexOf("@")) + "." + "0";
        var message = null;

        try
        {
            // d.getSignalProtocolStore)().loadSession(t);
            // t.decryptContent
            // decryptSignalProto
            switch (chiphertextType)
            {
                case "pkmsg":
                    // Pre-Key message
                    message = await MultiDevice.signalDecryptPrekeyWhisperMessage(ciphertext, storage, address);
                    break;
                case "msg":
                    // Regular message
                    message = await MultiDevice.signalDecryptWhisperMessage(ciphertext, storage, address);
                    break;
                case "skmsg":
                    // Sender Key message, aka group message
                    message = await MultiDevice.signalDecryptSenderKeyMessage(ciphertext, storage, remoteJid, address, keyDistributionMessage);
                    break;
            }
        }
        catch (e)
        {
            console.warn("Skipping decryption of " + chiphertextType + " from " + address + " due to exception.");
            console.warn(e);
            continue;
        }
        
        // unpad the message
        if (message == null) continue; 
        message = new Uint8Array(message);
        message = new Uint8Array(message.buffer, message.byteOffset, message.length - message[message.length - 1]);
    
        var decryptedMessage = Message.read(new Pbf(message));
        decryptedMessages.push(decryptedMessage);

        if (decryptedMessage.senderKeyDistributionMessage)
        {
            var keyDistributionMessage = decryptedMessage.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage;
            keyDistributionMessage = MultiDevice.signalGetKeyDistributionMessage(keyDistributionMessage);
        }
    }

    return decryptedMessages;
}

//
// Signal related code
//

MultiDevice.signalDecryptWhisperMessage = async function(whisperMessageBuffer, storage, address)
{
    var sessionObject = await storage.loadSession(address.toString());
    if (sessionObject == null)
    {
        console.error("Can't get session for " + address.toString());
        debugger;
    }

    var version = (new Uint8Array(whisperMessageBuffer))[0];
    var messageProto = whisperMessageBuffer.slice(1, whisperMessageBuffer.byteLength - 8);
    var whisperMessage = WhisperMessage.read(new Pbf(messageProto));

    var chainKey = null; var chainCounter = -1; var messageKeys = {};

    var recvChains = sessionObject.recvChains;
    var chainIndex = recvChains.findIndex((e => isEqualArray(e.ratchetPubKey,whisperMessage.ephemeralKey)))
    if (chainIndex != -1)
    {
        var currentChain = recvChains[chainIndex];
        chainKey = currentChain.chainKey;
        chainCounter = currentChain.nextMsgIndex;
        messageKeys = currentChain.unusedMsgKeys;
    }
    else
    {
        // calculate new chain, see decryptMsgFromSession -> calculateRatchet, makeFreshRecvChain
        var chainKeyData = await MultiDevice.calculateNewChainKey(sessionObject.rootKey, whisperMessage.ephemeralKey, 
                                                                sessionObject.sendChain.ratchetKey.privateKey);
        chainKey = chainKeyData.key;
        chainCounter = chainKeyData.counter;
    }

    var messageKey = await MultiDevice.signalGetMessageKey(chainKey, chainCounter, whisperMessage.counter, messageKeys);
    var keys = await libsignal.HKDF.deriveSecrets(messageKey, new ArrayBuffer(32), "WhisperMessageKeys");

    try
    {
        var plaintext = await libsignal.crypto.decrypt(keys[0], toArrayBuffer(whisperMessage.ciphertext), keys[2].slice(0, 16));
        return plaintext;
    }
    catch (exception)
    {
        console.error("E2E plaintext decryption failed.")
        debugger;
        throw exception;
    }
    
}

MultiDevice.signalDecryptPrekeyWhisperMessage = async function(prekeyWhisperMessageBuffer, storage, address)
{
    var sessionObject = await storage.loadSession(address.toString());

    var sessions = sessionObject ? sessionObject.sessions : {};

    var version = (new Uint8Array(prekeyWhisperMessageBuffer))[0];
    var messageProto = prekeyWhisperMessageBuffer.slice(1, prekeyWhisperMessageBuffer.byteLength);
    var prekeyMessage = PreKeyWhisperMessage.read(new Pbf(messageProto));

    var ourIdentityKey = await storage.getIdentityKeyPair();
    var ourEphemeralKey = await storage.loadPreKey(prekeyMessage.preKeyId); // preKeyPair
    var ourSignedKey = await storage.loadSignedPreKey(prekeyMessage.signedPreKeyId);

    version = (new Uint8Array(prekeyMessage.message))[0];
    messageProto = prekeyMessage.message.slice(1, prekeyMessage.message.byteLength - 8);
    var whisperMessage = WhisperMessage.read(new Pbf(messageProto));

    var chainKeyData = null;
    var messageKeys = {};

    if (sessionObject)
    {
        var recvChains = sessionObject.recvChains;
        var chainIndex = recvChains.findIndex((e => isEqualArray(e.ratchetPubKey, whisperMessage.ephemeralKey)))
        if (chainIndex != -1)
        {
            var currentChain = recvChains[chainIndex];
            chainKeyData = {key: currentChain.chainKey, counter: currentChain.nextMsgIndex};
            messageKeys = currentChain.unusedMsgKeys;
        }
    }
    else
    {
        // new session, see initiateSessionIncoming
        var sharedSecret = (ourEphemeralKey === undefined || prekeyMessage.baseKey === undefined) ? 
                            sharedSecret = new Uint8Array(32 * 4) : new Uint8Array(32 * 5);
        for (var i = 0; i < 32; i++) {
            sharedSecret[i] = 0xff;
        }
    
        var ecRes = new Array();
        ecRes[0] = await libsignal.Curve.async.calculateAgreement(prekeyMessage.baseKey, ourIdentityKey.privKey);
        ecRes[1] = await libsignal.Curve.async.calculateAgreement(prekeyMessage.identityKey, ourSignedKey.privKey);
        ecRes[2] = await libsignal.Curve.async.calculateAgreement(prekeyMessage.baseKey, ourSignedKey.privKey);
        sharedSecret.set(new Uint8Array(ecRes[0]), 32 * 2); sharedSecret.set(new Uint8Array(ecRes[1]), 32); sharedSecret.set(new Uint8Array(ecRes[2]), 32 * 3);
        if (ourEphemeralKey !== undefined && prekeyMessage.baseKey !== undefined) {
            var ecRes4 = await libsignal.Curve.async.calculateAgreement(prekeyMessage.baseKey, ourEphemeralKey.privKey);
            sharedSecret.set(new Uint8Array(ecRes4), 32 * 4);
        }
        var masterKey = await libsignal.HKDF.deriveSecrets(sharedSecret.buffer, new ArrayBuffer(32), "WhisperText");
        var rootKey = masterKey[0];
    
        // calculate new ratchet
        sharedSecret = await libsignal.Curve.async.calculateAgreement(whisperMessage.ephemeralKey, ourSignedKey.privKey);
        var keys = await libsignal.HKDF.deriveSecrets(sharedSecret, rootKey, "WhisperRatchet");
        var chainKey = keys[1];

        chainKeyData = {key: chainKey, counter: -1};
    }

    var messageKey = await MultiDevice.signalGetMessageKey(chainKeyData.key, chainKeyData.counter, whisperMessage.counter, messageKeys);
    var keys = await libsignal.HKDF.deriveSecrets(messageKey, new ArrayBuffer(32), "WhisperMessageKeys");
    var plaintext = await libsignal.crypto.decrypt(keys[0], toArrayBuffer(whisperMessage.ciphertext), keys[2].slice(0, 16));
    // plaintext makes sense? good.
    return plaintext;
        
}

MultiDevice.signalDecryptSenderKeyMessage = async function(senderKeyMessageBuffer, storage, groupId, address, keyDistributionMessage)
{
    var senderKeyName = `${groupId}::${address.toString()}`;
    var senderKey = await storage.loadSenderKey(senderKeyName);

    var version = new Uint8Array(senderKeyMessageBuffer)[0];
    var messageProto = senderKeyMessageBuffer.slice(1, senderKeyMessageBuffer.byteLength - 64);
    var senderKeyMessage = SenderKeyMessage.read(new Pbf(messageProto));
    var id = senderKeyMessage.id;
    
    var chainKey = null; var chainMsgCounter = -1; var messageKeys = {};

    if (senderKey)
    {
        // vesrion 2
        for (var e = 0; e < senderKey.senderKeyStates.length; e++)
        {
            if (senderKey.senderKeyStates[e].senderKeyId === id) 
            {
                chainKey =  senderKey.senderKeyStates[e].senderKeyChainKey.chainKey;
                chainMsgCounter = senderKey.senderKeyStates[e].senderKeyChainKey.nextMsgIndex;
                break; 
            }
        }
    }
    
    if (chainKey == null && keyDistributionMessage) // && keyDistributionMessage.id == id
    {
        chainKey = keyDistributionMessage.chainKey;
        chainMsgCounter = keyDistributionMessage.iteration;
    }

    if (chainKey == null) 
    { 
        console.warn("Session not found for " + senderKeyName); 
        return null;
    }

    var messageKey = await MultiDevice.signalGetMessageKey(chainKey, chainMsgCounter, senderKeyMessage.iteration, messageKeys, true);
            
    var keys = await libsignal.HKDF.deriveSecrets(messageKey, new ArrayBuffer(32), "WhisperGroup");
    var key = new Uint8Array(32);
    key.set(new Uint8Array(keys[0].slice(16))); key.set(new Uint8Array(keys[1].slice(0, 16)), 16);
    var iv = keys[0].slice(0, 16);
    var plaintext = await libsignal.crypto.decrypt(key.buffer, senderKeyMessage.ciphertext, iv);
    // plaintext makes sense? good.
    return plaintext;
}

MultiDevice.signalGetKeyDistributionMessage = function(keyDistributionMessageBuffer)
{
    var version = new Uint8Array(keyDistributionMessageBuffer)[0];
    var messageProto = keyDistributionMessageBuffer.slice(1, keyDistributionMessageBuffer.byteLength);
    var senderKeyMessage = WhisperSenderKeyDistributionMessage.read(new Pbf(messageProto));

    return senderKeyMessage;
}

// new ratchet: root key -> chain key
MultiDevice.calculateNewChainKey = async function(rootKey, ratchetPubKey, ratchetPrivKey)
{
    if (!(ratchetPrivKey instanceof ArrayBuffer))
        ratchetPrivKey = toArrayBuffer(ratchetPrivKey);

    var sharedSecret = await libsignal.Curve.async.calculateAgreement(ratchetPubKey, ratchetPrivKey);
    var keys = await libsignal.HKDF.deriveSecrets(sharedSecret, rootKey, "WhisperRatchet");

    return {key: keys[1], counter: -1};
}

MultiDevice.signalGetMessageKey = async function(chainKey, chainMsgCounter, counter, messageKeys={}, isSenderKey=false)
{
    if (messageKeys && messageKeys[counter] != undefined) 
    {
        // already calculated
        return messageKeys[counter];
    }

    if (counter < chainMsgCounter) 
    {
        console.warn("Possible duplicated message (counter < chain message counter)"); // look in messageKeys?
        throw "possbile duplicated message";
        debugger;
    }

    var messageKey = null;
    
    //if (counter == chainMsgCounter || isSenderKey)
    if (chainMsgCounter != -1)
    {
        // the message key should be already calculated, but sometimes it seems not
        counter++;
    }
    
    for (var i = chainMsgCounter; i < counter; i++)
    {
        messageKey = await MultiDevice.HMAC_SHA256(toArrayBuffer(new Uint8Array([0x1])), chainKey);
        chainKey = await MultiDevice.HMAC_SHA256(toArrayBuffer(new Uint8Array([0x2])), chainKey);
    }

    return messageKey;
}

//
// Helper functions
//

MultiDevice.HMAC_SHA256 = async function(toSign, key)
{
    var importedKey = await window.crypto.subtle.importKey("raw", key, {name: "HMAC", hash: {name: "SHA-256"} }, false, ["sign", "verify"]);
    var signature = await window.crypto.subtle.sign("HMAC", importedKey, toSign);
    return signature;
}

MultiDevice.enqueuePromise = async function(promise, argument, isIncoming = false)
{
    var queue = isIncoming ? MultiDevice.incomingQueue : MultiDevice.outgoingQueue;
    return queue.enqueue(promise, argument);
};

MultiDevice.numPacketsSinceHandshake = 0;
MultiDevice.looksLikeHandshakePacket = function(payload)
{
    // Noise protocol handshake flow:
    //    --> e                                                             [client hello]
    //    <-- e, s (encrypted), payload (encrypted NoiseCertificate)        [server hello]
    //    --> s (encrypted public key), payload (encrypted ClientPayload)   [client finish]
    // https://noiseprotocol.org/noise.html#handshake-patterns

    if (payload.byteLength < 8)
    {
        console.log("WAIncognito: got small packet:");
        console.log(payload);
        return true;
    }

    var binaryReader = new BinaryReader();
    binaryReader.writeBuffer(payload);

    var startOffset = 3;
    if (binaryReader._readIndex = 0, binaryReader.readUint16() == 0x5741) startOffset = 0x7; // chat
    if (binaryReader._readIndex = 0xB, binaryReader.readUint16() == 0x5741) startOffset = 0x12; // chat?ED={routingToken}

    if (startOffset > 3) MultiDevice.numPacketsSinceHandshake = 0; // client hello
    if (++MultiDevice.numPacketsSinceHandshake > 3) return false;

    var binary = payload.slice(startOffset, payload.length);
    try
    {
        var handshakeMessage = HandshakeMessage.read(new Pbf(binary));
    }
    catch
    {
        return false;
    }

    if (window.WAdebugMode)
    {
        if (handshakeMessage.clientHello) console.log("WAIncognito: client hello", handshakeMessage.clientHello);
        if (handshakeMessage.serverHello) console.log("WAIncognito: server hello", handshakeMessage.serverHello);
        if (handshakeMessage.clientFinish) console.log("WAIncognito: client finish", handshakeMessage.clientFinish);
    }

    return handshakeMessage.clientHello || handshakeMessage.serverHello || handshakeMessage.clientFinish;
};

MultiDevice.counterToIV = function(counter)
{
    const buffer = new ArrayBuffer(12);
    new DataView(buffer).setUint32(8, counter);
    return new Uint8Array(buffer);
};

function toArrayBuffer(array)
{
    return array.buffer.slice(array.byteOffset, array.byteLength + array.byteOffset);
}

// https://medium.com/@karenmarkosyan/how-to-manage-promises-into-dynamic-queue-with-vanilla-javascript-9d0d1f8d4df5
class PromiseQueue {
    constructor()
    {
        this.queue = [];
        this.pendingPromise = false;
    }

    enqueue(promise, argument) {
      return new Promise((resolve, reject) => {
          this.queue.push({
              promise,
              argument,
              resolve,
              reject,
          });
          this.dequeue();
      });
    }
  
  dequeue() {
      if (this.workingOnPromise) {
        return false;
      }
      const item = this.queue.shift();
      if (!item) {
        return false;
      }
      try {
        this.workingOnPromise = true;
        item.promise(item.argument)
          .then((value) => {
            this.workingOnPromise = false;
            item.resolve(value);
            this.dequeue();
          })
          .catch(err => {
            this.workingOnPromise = false;
            item.reject(err);
            this.dequeue();
          })
      } catch (err) {
        this.workingOnPromise = false;
        item.reject(err);
        this.dequeue();
      }
      return true;
    }
}


MultiDevice.initialize();
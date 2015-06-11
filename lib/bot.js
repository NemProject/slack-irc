var _ = require('lodash');
var irc = require('irc');
var logger = require('winston');
var Slack = require('slack-client');
var errors = require('./errors');
var validateChannelMapping = require('./validators').validateChannelMapping;
var emojis = require('./emoji');
var fs = require("fs");
var http = require('http');

var REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];

Slack.prototype.getDMByUserId = function(userId) {
    return _.find(this.dms, {user: userId});
};


function Nem(options) {
  var X = ['host', 'port'];
  X.forEach(function(field) {
    if (!options[field]) {
      throw new errors.ConfigurationError('Missing configuration field ' + field);
    }
  });
 
  this.host = options.host;
  this.port = options.port;
}

Nem.prototype.chainHeight = function(cb) {
  return this.get(this.host, this.port, '/chain/height', cb);
};

Nem.prototype.accountGenerate = function(cb) {
  return this.get(this.host, this.port, '/account/generate', cb);
};

Nem.prototype.balanceGen = function(address, back, cb) {
  var self = this;
  this.chainHeight(function(data){
    var h = data.height - back;
    var url = '/account/historical/get?address='+address+'&startHeight='+h+'&endHeight='+h+'&increment=1';
    return self.get('bigalice3.nem.ninja', 7890, url, cb);
  });
}


Nem.prototype.balance10 = function(address, cb) {
  return this.balanceGen(address, 10, cb);
}

Nem.prototype.get = function(urihost, uriport, uripath, cb) {
  var options = {
    host: urihost,
    port: uriport,
    path: uripath,
    method: 'GET'
  }; 
  var req = http.request(options, function(res) {
    res.setEncoding('utf8');
    var body = '';
    res.on('data', function (chunk) {
      body += chunk;
    });
    res.on('end', function() { var parsed = JSON.parse(body); cb(parsed); });
  });
  req.on('error', function(e) {
    logger.warn('problem with request: ' + e.message);
  });
  req.write('');
  req.end();
};

Nem.prototype.post = function(urihost, uriport, uripath, options, cb) {
  var dataSend = JSON.stringify(options);
  var options = {
    host: urihost,
    port: uriport,
    path: uripath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': dataSend.length
    }
  }; 
  var req = http.request(options, function(res) {
    res.setEncoding('utf8');
    var body = '';
    res.on('data', function (chunk) {
      body += chunk;
    });
    res.on('end', function() { 
      try{
        var parsed = JSON.parse(body);
        cb(parsed);
      } catch(e) {
        logger.error(e);
      }
    });
  });
  req.on('error', function(e) {
    logger.warn('problem with request: ' + e.message);
  });
  req.write(dataSend);
  req.end();
};


Nem.prototype.nodeExtendedInfo = function(cb) {
  return this.get(this.host, this.port, '/node/extended-info', cb);
};

Nem.prototype.makeTransfer = function(depositData, address, amount, fee, cb) { 
  var self = this;
  self.nodeExtendedInfo(function(data){
    var options = {
       transaction: 
       { 
         timeStamp: data.nisInfo.currentTime,
         amount: amount*1000000,
         fee: fee*1000000,
         recipient: address,
         type: 257, 
         deadline: data.nisInfo.currentTime + 60*60, 
         version: 1744830465,
         signer: depositData.publicKey
       }, 
       privateKey: depositData.privateKey
    };
    self.post(self.host, self.port, '/transaction/prepare-announce', options, cb);
  });
};

function Nemdb(options) {
  this.sufix = options;
  this.load();
}

Nemdb.prototype.load = function() {
  var file = 'test-db-'+this.sufix+'.json';
  if (fs.existsSync(file)) {
    this.users = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    this.users = {};
  }
  this.save();
};

Nemdb.prototype.save = function() {
  var file = 'test-db-'+this.sufix+'.json';
  do {
    try {
      var ret = fs.openSync(file + '.lock', 'wx');
      fs.closeSync(ret);
  
      var out = fs.openSync(file, 'w');
      fs.writeSync(out, JSON.stringify(this.users), 0, 'utf-8');
      fs.closeSync(out);
  
      fs.unlinkSync(file + '.lock');
      return;
    }
    catch(e) {
      logger.warn(e);
    }
  } while(true);
};

Nemdb.prototype.getDeposit = function(user) {
  if (user.id in this.users) {
    if ('deposit' in this.users[user.id]) {
      return this.users[user.id].deposit.address;
    }
  }
  return null;
};

Nemdb.prototype.getDepositData = function(user) {
  return this.users[user.id].deposit;
}

Nemdb.prototype.addUser = function(user, depositKey)
{
  if (!(user.id in this.users)) {
    this.users[user.id] = {}
  }
  this.users[user.id]['deposit'] = depositKey;
  this.save();
  return depositKey.address;
};
 
/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
function Bot(options) {
  REQUIRED_FIELDS.forEach(function(field) {
    if (!options[field]) {
      throw new errors.ConfigurationError('Missing configuration field ' + field);
    }
  });

  validateChannelMapping(options.channelMapping);

  this.nemdb = new Nemdb(options.nickname);
  this.nem = new Nem({host:'localhost', port:9999});
  this.slack = new Slack(options.token);

  this.server = options.server;
  this.nickname = options.nickname;
  this.ircOptions = options.ircOptions;

  this.channels = _.values(options.channelMapping);

  this.channelMapping = {};

  // Remove channel passwords from the mapping and lowercase IRC channel names
  _.forOwn(options.channelMapping, function(ircChan, slackChan) {
    this.channelMapping[slackChan] = ircChan.split(' ')[0].toLowerCase();
  }, this);

  this.invertedMapping = _.invert(this.channelMapping);

  this.autoSendCommands = options.autoSendCommands || [];
}

Bot.prototype.connect = function() {
  logger.debug('Connecting to IRC and Slack');
  this.slack.login();

  var ircOptions = _.assign({
    userName: this.nickname,
    realName: this.nickname,
    channels: this.channels,
    floodProtection: true,
    floodProtectionDelay: 500
  }, this.ircOptions);

  this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
  this.attachListeners();
};

Bot.prototype.attachListeners = function() {
  this.slack.on('open', function() {
    logger.debug('Connected to Slack');
  });

  this.ircClient.on('registered', function(message) {
    logger.debug('Registered event: ', message);
    this.autoSendCommands.forEach(function(element) {
      this.ircClient.send.apply(this.ircClient, element);
    }, this);
  }.bind(this));

  this.ircClient.on('error', function(error) {
    logger.error('Received error event from IRC', error);
  });

  this.slack.on('error', function(error) {
    logger.error('Received error event from Slack', error);
  });

  this.slack.on('message', function(message) {
    // Ignore bot messages and people leaving/joining
    if (message.type === 'message' && !message.subtype) {
      this.sendToIRC(message);
    }
  }.bind(this));

  this.ircClient.on('message', this.sendToSlack.bind(this));

  this.ircClient.on('invite', function(channel, from) {
    logger.debug('Received invite:', channel, from);
    if (!this.invertedMapping[channel]) {
      logger.debug('Channel not found in config, not joining:', channel);
    } else {
      this.ircClient.join(channel);
      logger.debug('Joining channel:', channel);
    }
  }.bind(this));
};

Bot.prototype.parseText = function(text) {
  return text
    .replace(/\n|\r\n|\r/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<!channel>/g, '@channel')
    .replace(/<!group>/g, '@group')
    .replace(/<!everyone>/g, '@everyone')
    .replace(/<#(C\w+)\|?(\w+)?>/g, function(match, channelId, readable) {
      return readable || '#' + this.slack.getChannelByID(channelId).name;
    }.bind(this))
    .replace(/<@(U\w+)\|?(\w+)?>/g, function(match, userId, readable) {
      return readable || '@' + this.slack.getUserByID(userId).name;
    }.bind(this))
    .replace(/<(?!!)(\S+)>/g, function(match, link) {
      return link;
    })
    .replace(/<!(\w+)\|?(\w+)?>/g, function(match, command, label) {
      if (label) {
        return '<' + label + '>';
      }

      return '<' + command + '>';
    })
    .replace(/\:(\w+)\:/g, function(match, emoji) {
      if (emoji in emojis) {
        return emojis[emoji];
      }

      return match;
    });
};

Bot.prototype.sendToChan = function(ircChannel, chan, textData) {
  if (! chan.is_channel) {
    return;
  }
  logger.info('chan(', chan.id, ',', chan.name, ',', ircChannel, ')', textData);

  var message = {
    text: textData,
    channel: chan,
    username: 'tipbot',
    parse: 'full'
  };
  chan.postMessage(message);

  this.ircClient.say(ircChannel, textData);
};


Bot.prototype.sendToUser = function(user, textData) {
    logger.info('user(', user.id, ',', user.name, ')', textData);

    var channel = this.slack.getDMByUserId(user.id)
    if (!channel) {
      logger.warn('no channel');
      return;
    }

    var message = {
      text: textData,
      channel: channel,
      username: 'tipbot',
      parse: 'full'
    };
    channel.postMessage(message);
};
Bot.prototype.send = function(dest, textData) {
  var ircChannel = dest.ircChannel;
  var chan = dest.chan;
  var user = dest.user;
  var msg = textData
  this.sendToUser(user, msg);
  this.sendToChan(ircChannel, chan, '@'+user.name+' '+msg);
};

Bot.prototype.sendHelp = function(user) {
  this.sendToUser(user, "*TIPBOT COMMANDS* \n" +
	"Commands, that can be used in a private 1 to 1 chat with ircbot:\n" +
        " - *balance*\t\task the bot for your current balance; \n" +
        " - *send*\t\t\t\ttell the bot to send coins to someone; 'send @gimre 2', omitting amount will use 10\n" +
        " - *deposit*\t\task the bot for a deposit address; \n" +
        " - *withdraw*\ttell the bot to withdraw to a address; 'withdraw YOUR-NEM-ADDRESS amount, omitting amount will cause all the funds to be withdrawn\n\n" +
	"Commands, that can be used in #general channel:\n" +
	" - *tip*\t\ttell the bot to tip to someone by typing '!tip @gimre 1', ommitting amount will use 10\n" +
        " tipbot donate ndthb6-dvxhj5-iio4bt-qd6fy4-jptxtx-TIPBOT-tl53 \n");
};

Bot.prototype.createDeposit = function(user, cb) {
  var self = this;
  var deposit = this.nemdb.getDeposit(user);
  if (!deposit) {
    this.nem.accountGenerate(function(accountData){
      var ret = self.nemdb.addUser(user, accountData);
      logger.info('new deposit address: ', user.id, ret);
      cb(ret, 1);
    });
  } else {
    logger.info('cached deposit address: ', user.id, '->', deposit);
    cb(deposit, 0);
  }
};

function fee(amount) {
  var FEE_UNIT = 2;
  var FEE_MULTIPLIER = 5;
  var numNem = amount;
  var smallTransferPenalty = (FEE_UNIT * 5) - numNem;
  var largeTransferFee = Math.floor(Math.atan(numNem / 150000.) * FEE_MULTIPLIER * 33);
  var transferFee = Math.max(smallTransferPenalty, Math.max(FEE_UNIT, largeTransferFee));
  return transferFee;
}

Bot.prototype.sendWithdraw = function(user, body) {
  var address = this.nemdb.getDeposit(user);
  var self = this;
  if (!address) {
    self.sendToUser(user, 'You don\'t have any deposit\n');
    return;
  }

  var p = body.match(/\s*(withdraw)\s+(n[2-7a-z-]+)\s*(\d+)?/i);;
  if (!p || p.length !== 4) {
    self.sendToUser(user, 'Error in withdraw command\n');
    return;
  }

  var destAddr = p[2].replace(/-/g, '');
  if (destAddr.length != 40) {
    self.sendToUser(user, 'target nem address musth have 40 characters, you probably have a typo');
    return;
  }
 
  this.nem.balanceGen(address, 2, function(data){
    var data = data.data[0];
    var b = Math.floor(data.balance / 1000000);
    var f = fee(b);
    var amount = (p[3] === undefined) ? b-f : parseInt(p[3]);
    if (isNaN(amount)) {
      self.sendToUser(user, 'Can\'t send: '+amountStr+'\n');
      return;
    }

    if (amount + f > b) {
      self.sendToUser(user, 'Not enough funds on your deposit, to make transaction ('+address+', '+amount+'+'+f+', but have only: '+b+')\n');
      return;
    }

    var depositData = self.nemdb.getDepositData(user);
    self.nem.makeTransfer(depositData, destAddr, amount, f, function(data) {
      if (('code' in data) && data['code'] == 1) {
        self.sendToUser(user, 'WITHDRAWN ' + amount + ' to ' + destAddr + ' (' + data.message + ')\n');
        self.sendToUser(user, 'TX HASH ' + data.transactionHash.data);

      } else {
        self.sendToUser(user, 'FAILURE');
        self.sendToUser(user, JSON.stringify(data));
      }
    });
  });

};

Bot.prototype.sendSend = function(dest, body) {
  var ircChannel = dest.ircChannel;
  var chan = dest.chan;
  var user = dest.user;
  var self = this;

  var p = body.match(/.*(send|!tip|tip)\s+(<@(U\w+)>[^\d]*(\d+)|(\d+)[^<]*<@(U\w+)>)?/i)
  if (!p || p.length < 7) {
    if (p && p.length < 7) {
      self.sendToUser(user, 'Error in send command\n');
    }
    return;
  }

  if (p[2] === undefined) {
    self.sendToUser('couldn\'t find username');
    logger.warn(body);
    return;
  }

  var destUser = p[3];
  var amountStr = p[4];
  if (destUser === undefined) {
    amountStr = p[5];
    destUser = p[6];
  }
 
  var address = this.nemdb.getDeposit(user);
  if (!address) {
    self.sendToUser(user, 'You don\'t have any deposit\n');
    return;
  }

  amountStr = (amountStr === undefined) ? "10" : amountStr;
  var amount = parseInt(amountStr);
  if (isNaN(amount)) {
    self.sendToUser(user, 'Can\'t send: '+amountStr+' XEM, not a number\n');
    return;
  }

  this.nem.balance10(address, function(data){
    var data = data.data[0];
    var b = Math.floor(data.balance / 1000000);
    var f = fee(amount);
    if (amount + f > b) {
      self.sendToUser(user, 'Not enough funds on your deposit, to make transaction ('+address+', '+b+')\n');
      return;
    }

    logger.info('user ' + user.id + ' wants to send ' + amount + ' to ' + destUser);
    var destinationMember = self.slack.getUserByID(destUser);
    if (!destinationMember) {
      self.sendToUser(user, 'problem with finding the user ');
      return;
    }
    if (destinationMember.is_bot) {
      self.send(dest, 'I won\'t send XEM to a bot!');
      return;
    }
    self.createDeposit(destinationMember, function(destination, id){
      if (id === 1) {
        self.sendToUser(destinationMember, "Hi, I have create a tipbot account for you. \"help\" to get help ;)");
        // NO return here, this was not an error
      }
      if (destination === address) {
        self.send(dest, 'It seems to me you\'re trying to tip yourself. To avoid the fees I won\'t do that!\n');
        return;
      } 

      var depositData = self.nemdb.getDepositData(user);
      self.nem.makeTransfer(depositData, destination, amount, f, function(data) {
        if (('code' in data) && data['code'] == 1) {
          self.sendToUser(user, 'SENT ' + amount + ' to ' + destinationMember.name + ' (' + data.message + ')\n');
          self.sendToUser(user, 'TX HASH ' + data.transactionHash.data);

          self.sendToUser(destinationMember, 'User @' + user.name + ' has just tipped you with ' + amount + ' XEM\n');
          self.sendToChan(ircChannel, chan, 'User @' + user.name + ' has just tipped '+destinationMember.name+' with ' + amount + ' XEM\n');
        } else {
          self.sendToUser(user, 'FAILURE');
          self.sendToUser(user, JSON.stringify(data));
        }
      });
    });
  });
};

Bot.prototype.sendBalance = function(user) {
  var address = this.nemdb.getDeposit(user);
  var self = this;
  if (!address) {
    self.sendToUser(user, 'You don\'t have any deposit\n');
  } else {
    this.nem.balance10(address, function(data){
      var data = data.data[0];
      var b = data.balance / 1000000;
      self.sendToUser(user, 'Your balance at block ' + data.height + ' is *' + Math.floor(b) + '*.'+(b-Math.floor(b))+'\n');
    });
  }
};

Bot.prototype.handleCommands = function(dest, body) {
    var self = this;
    var text = this.parseText(body);
    var a = text.toLowerCase().split(" ");
    var h = a.length > 0 ? a[0] : '';

    var chan = dest.chan;
    var user = dest.user;

    if (! chan.is_channel) {
      switch (h) {
        case "help":
          this.sendHelp(user);
          break;
        case "deposit":
          this.createDeposit(user, function(deposit, code) {
            self.sendToUser(user, 'Your deposit address: *' + deposit +'*\n');
          });
          break;
        case "balance":
          this.sendBalance(user);
          break;
        case "send":
	case "!tip":
	case "tip":
          this.sendSend(dest, body);
          break;
        case "withdraw":
          this.sendWithdraw(user, body);
          break;
      }
    } else {
      this.sendSend(dest, body);
    }
};

Bot.prototype.sendToIRC = function(message) {
  var channel = this.slack.getChannelGroupOrDMByID(message.channel);
  var member = this.slack.getUserByID(message.user);

  if (!channel) {
    logger.info('Received message from a channel the bot isn\'t in:',
      message.channel);
    return;
  }

  var channelName = channel.is_channel ? '#' + channel.name : channel.name;
  var ircChannel = this.channelMapping[channelName];
  logger.debug('channel ', channelName, this.channelMapping[channelName]);

  logger.info(channel.name, channel.is_channel, member.name);

  if (ircChannel) {
    this.handleCommands({chan:channel, user:member, ircChannel:ircChannel}, message.getBody());
    
    var text = '<' + member.name + '> ' + this.parseText(message.getBody());
    logger.debug('Sending message to IRC', channelName, text);
    this.ircClient.say(ircChannel, text);

  } else {
    this.handleCommands({chan:channel, user:member}, message.getBody());
  }
};

Bot.prototype.sendToSlack = function(author, channel, text) {
  var slackChannelName = this.invertedMapping[channel.toLowerCase()];
  if (slackChannelName) {
    var slackChannel = this.slack.getChannelGroupOrDMByName(slackChannelName);

    if (!slackChannel) {
      logger.info('Tried to send a message to a channel the bot isn\'t in: ',
        slackChannelName);
      return;
    }

    var message = {
      text: text,
      username: author,
      parse: 'full',
      icon_url: 'http://api.adorable.io/avatars/48/' + author + '.png'
    };
    logger.debug('Sending message to Slack', message, channel, '->', slackChannelName);
    slackChannel.postMessage(message);
  }
};

module.exports = Bot;

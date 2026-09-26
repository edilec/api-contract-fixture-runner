import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import dns from 'node:dns'

const forbidden = () => { throw new Error('A network operation was attempted during an offline test.') }

net.Socket.prototype.connect = forbidden
net.Server.prototype.listen = forbidden
net.connect = forbidden
net.createConnection = forbidden
http.request = forbidden
http.get = forbidden
https.request = forbidden
https.get = forbidden
dgram.Socket.prototype.bind = forbidden
dgram.Socket.prototype.send = forbidden
dns.lookup = forbidden
dns.resolve = forbidden
globalThis.fetch = forbidden
syncBuiltinESMExports()

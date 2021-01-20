import { decode as _decode } from '../decode.js'
import { Token, Type } from '../token.js'
import { decodeCodePointsArray } from '../byte-utils.js'

class Tokeniser {
  constructor (data, options = {}) {
    this.pos = 0
    this.data = data
    this.options = options
    this.modeStack = ['value']
    this.lastToken = ''
  }

  done () {
    return this.pos >= this.data.length
  }

  ch () {
    return this.data[this.pos]
  }

  currentMode () {
    return this.modeStack[this.modeStack.length - 1]
  }

  skipWhitespace () {
    let c = this.ch()
    while (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      c = this.data[++this.pos]
    }
  }

  expect (str) {
    if (this.data.length - this.pos < str.length) {
      throw new Error('Unexpected end of input')
    }
    for (let i = 0; i < str.length; i++) {
      if (this.data[this.pos++] !== str[i]) {
        throw new Error(`Unexpected token @ char ${this.pos}, expected to find '${String.fromCharCode(...str)}'`)
      }
    }
  }

  parseNumber () {
    const startPos = this.pos
    let str = ''

    const swallow = (chars) => {
      while (!this.done()) {
        const ch = this.ch()
        if (chars.includes(ch)) {
          str += String.fromCharCode(ch)
          this.pos++
        } else {
          break
        }
      }
    }

    if (this.ch() === 45) { // '-'
      str = '-'
      this.pos++
      if (this.ch() === 48) { // '0'
        throw new Error(`Invalid leading 0 for negative number at position ${this.pos}`)
      }
    }
    swallow([48, 49, 50, 51, 52, 53, 54, 55, 56, 57]) // DIGIT
    if (str === '-') {
      throw new Error(`Unexpected token at position ${this.pos}`)
    }
    if (!this.done() && this.ch() === 46) { // '.'
      str += '.'
      this.pos++
      swallow([48, 49, 50, 51, 52, 53, 54, 55, 56, 57]) // DIGIT
      if (!this.done() && (this.ch() === 101 || this.ch() === 69)) { // '[eE]'
        str += 'e'
        this.pos++
        if (!this.done() && this.ch() === 43) { // '+'
          str += '+'
          this.pos++
        } else if (!this.done() && this.ch() === 45) { // '-'
          str += '-'
          this.pos++
        }
        swallow([48, 49, 50, 51, 52, 53, 54, 55, 56, 57]) // DIGIT
      }
    }
    // TODO: check canonical form of this number?
    const float = parseFloat(str)
    return new Token(Number.isInteger(float) ? float >= 0 ? Type.uint : Type.negint : Type.float, float, this.pos - startPos)
  }

  parseString () {
    const startPos = this.pos
    const chars = []

    const readu4 = () => {
      if (this.pos + 4 >= this.data.length) {
        throw new Error(`Unexpected end of string at position ${this.pos}`)
      }
      let u4 = 0
      for (let i = 0; i < 4; i++) {
        let ch = this.ch()
        if (ch >= 48 && ch <= 57) { // '0' && '9'
          ch -= 48
        } else if (ch >= 97 && ch <= 102) { // 'a' && 'f'
          ch = ch - 97 + 10
        } else if (ch >= 65 && ch <= 70) { // 'A' && 'F'
          ch = ch - 65 + 10
        } else {
          throw new Error(`Unexpected unicode escape character at position ${this.pos}`)
        }
        u4 = u4 * 16 + ch
        this.pos++
      }
      return u4
    }

    // mostly taken from feross/buffer and adjusted to fit
    const readUtf8Char = () => {
      const firstByte = this.ch()
      let codePoint = null
      let bytesPerSequence = (firstByte > 0xef) ? 4 : (firstByte > 0xdf) ? 3 : (firstByte > 0xbf) ? 2 : 1

      if (this.pos + bytesPerSequence > this.data.length) {
        throw new Error(`Unexpected unicode sequence at position ${this.pos}`)
      }

      let secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = this.data[this.pos + 1]
          if ((secondByte & 0xc0) === 0x80) {
            tempCodePoint = (firstByte & 0x1f) << 0x6 | (secondByte & 0x3f)
            if (tempCodePoint > 0x7f) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = this.data[this.pos + 1]
          thirdByte = this.data[this.pos + 2]
          if ((secondByte & 0xc0) === 0x80 && (thirdByte & 0xc0) === 0x80) {
            tempCodePoint = (firstByte & 0xf) << 0xc | (secondByte & 0x3f) << 0x6 | (thirdByte & 0x3f)
            /* c8 ignore next 3 */
            if (tempCodePoint > 0x7ff && (tempCodePoint < 0xd800 || tempCodePoint > 0xdfff)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = this.data[this.pos + 1]
          thirdByte = this.data[this.pos + 2]
          fourthByte = this.data[this.pos + 3]
          if ((secondByte & 0xc0) === 0x80 && (thirdByte & 0xc0) === 0x80 && (fourthByte & 0xc0) === 0x80) {
            tempCodePoint = (firstByte & 0xf) << 0x12 | (secondByte & 0x3f) << 0xc | (thirdByte & 0x3f) << 0x6 | (fourthByte & 0x3f)
            if (tempCodePoint > 0xffff && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }

      /* c8 ignore next 5 */
      if (codePoint === null) {
        // we did not generate a valid codePoint so insert a
        // replacement char (U+FFFD) and advance only 1 byte
        codePoint = 0xfffd
        bytesPerSequence = 1
      } else if (codePoint > 0xffff) {
        // encode to utf16 (surrogate pair dance)
        codePoint -= 0x10000
        chars.push(codePoint >>> 10 & 0x3ff | 0xd800)
        codePoint = 0xdc00 | codePoint & 0x3ff
      }

      chars.push(codePoint)
      this.pos += bytesPerSequence
    }

    if (this.ch() !== 34) { // '"'
      // this would be a programming error
      throw new Error(`Unexpected character at position ${this.pos}`)
    }
    this.pos++
    // TODO: could take the approach of a quick first scan for special chars like encoding/json/decode.go#unquoteBytes
    // and converting all of the ascii chars from the base array in bulk
    while (!this.done()) {
      const ch = this.ch()
      let ch1
      switch (ch) {
        case 92: // '\'
          this.pos++
          if (this.done()) {
            throw new Error(`Unexpected string character at position ${this.pos}`)
          }
          ch1 = this.ch()
          this.pos++
          switch (ch1) {
            case 34: // '"'
            case 39: // '\''
            case 92: // '\'
            case 47: // '/'
              chars.push(ch1)
              break
            case 98: // 'b'
              chars.push(8)
              break
            case 116: // 't'
              chars.push(9)
              break
            case 110: // 'n'
              chars.push(10)
              break
            case 102: // 'f'
              chars.push(12)
              break
            case 114: // 'r'
              chars.push(13)
              break
            case 117: // 'u'
              chars.push(readu4())
              break
            default:
              throw new Error(`Unexpected string escape character at position ${this.pos}`)
          }
          break
        case 34: // '"'
          this.pos++
          return new Token(Type.string, decodeCodePointsArray(chars), this.pos - startPos)
        default:
          if (ch < 32) { // ' '
            throw new Error(`Invalid control character at position ${this.pos}`)
          } else if (ch < 0x80) {
            chars.push(ch)
            this.pos++
          } else {
            readUtf8Char()
          }
      }
    }
  }

  parseKey () {
    return this.parseString()
  }

  parseValue () {
    switch (this.ch()) {
      case 123: // '{'
        this.modeStack.push('obj-start')
        this.pos++
        return new Token(Type.map, Infinity, 1)
      case 91: // '['
        this.modeStack.push('array-start')
        this.pos++
        return new Token(Type.array, Infinity, 1)
      case 34: { // '"'
        return this.parseString()
      }
      case 110: // 'n' / null
        this.expect([110, 117, 108, 108]) // 'null'
        return new Token(Type.null, null, 4)
      case 102: // 'f' / // false
        this.expect([102, 97, 108, 115, 101]) // 'false'
        return new Token(Type.false, false, 5)
      case 116: // 't' / // true
        this.expect([116, 114, 117, 101]) // 'true'
        return new Token(Type.true, true, 4)
      case 45: // '-'
      case 49: // '1', note case 48 / '0' is not allowed by spec
      case 50: // '2'
      case 51: // '3'
      case 52: // '4'
      case 53: // '5'
      case 54: // '6'
      case 55: // '7'
      case 56: // '8'
      case 57: // '9'
        return this.parseNumber()
      default:
        throw new Error(`Unexpected character at position ${this.pos}`)
    }
  }

  next () {
    this.skipWhitespace()
    switch (this.currentMode()) {
      case 'value':
        this.modeStack.pop()
        return this.parseValue()
      case 'array-value': {
        this.modeStack.pop()
        if (this.ch() === 93) { // ']'
          this.pos++
          return new Token(Type.break, undefined, 1)
        }
        if (this.ch() !== 44) { // ','
          throw new Error(`Unexpected character at position ${this.pos}`)
        }
        this.pos++
        this.modeStack.push('array-value')
        return this.parseValue()
      }
      case 'array-start': {
        this.modeStack.pop()
        if (this.ch() === 93) { // ']'
          this.pos++
          return new Token(Type.break, undefined, 1)
        }
        this.modeStack.push('array-value')
        return this.parseValue()
      }
      case 'obj-key':
        if (this.ch() === 125) { // '}'
          this.pos++
          return new Token(Type.break, undefined, 1)
        }
        if (this.ch() !== 44) { // ','
          throw new Error(`Unexpected character at position ${this.pos} ${String.fromCharCode(this.ch())}`)
        }
        this.pos++
        this.skipWhitespace()
      case 'obj-start': { // eslint-disable-line no-fallthrough
        this.modeStack.pop()
        if (this.ch() === 125) { // '}'
          this.pos++
          return new Token(Type.break, undefined, 1)
        }
        const token = this.parseString()
        this.skipWhitespace()
        if (this.ch() !== 58) { // ':'
          throw new Error(`Unexpected character at position ${this.pos}`)
        }
        this.pos++
        this.modeStack.push('obj-value')
        return token
      }
      case 'obj-value': {
        this.modeStack.pop()
        this.modeStack.push('obj-key')
        return this.parseValue()
      }
    }
  }
}

function decode (data, options) {
  options = Object.assign({ tokenizer: new Tokeniser(data, options) }, options)
  return _decode(data, options)
}

export { decode }
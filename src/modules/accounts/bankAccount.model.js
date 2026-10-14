import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

/**
 * The company's own bank accounts (B4 extra ক): where a bank transfer arrived, where a cheque is
 * deposited. Never deleted once used — deactivate instead.
 */
const bankAccountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 }, // 'DBBL Motijheel — Collection'
    bankName: { type: String, required: true, trim: true, maxlength: 120 },
    branch: { type: String, trim: true, maxlength: 120, default: null },
    accountName: { type: String, trim: true, maxlength: 160, default: null },
    accountNo: { type: String, required: true, trim: true, maxlength: 40 },
    routingNo: { type: String, trim: true, maxlength: 20, default: null },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'bank_accounts', optimisticConcurrency: true },
);

bankAccountSchema.plugin(baseSchema);
bankAccountSchema.index(
  { orgId: 1, accountNo: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } },
);

export const BankAccount = mongoose.model('BankAccount', bankAccountSchema);

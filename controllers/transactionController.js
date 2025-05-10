const { log } = require("handlebars");
const Transaction = require("../models/transactions.js");
const User = require("../models/user.js");
const axios = require("axios");

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';

const transactionController = {
  getBalance: async (req, res) => {
    const { userId } = req.params;

    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }

      const transactions = await Transaction.find({ userId: user._id });

      res.json({
        balance: user.balance,
        transactions,
        user: {
          bankCode: user.bankCode,
          accountNumber: user.accountNumber
        }
      });
    } catch (error) {
      res.status(500).send('Internal Server Error');
    }
  },

  getBanks: async (req, res) => {
    try {
      const response = await axios.get(`${flutterwaveBaseURL}banks/NG`, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });
      // console.log(response)
      res.status(200).json({
        message: response.data.message,
        data: response.data.data
      });

    } catch (error) {
      console.error('Error during verification:', error.response ? error.response.data : error.message);
      res.status(500).send('Internal Server Error');
    }
  },

  verifyAccount: async (req, res) => {
    const { accountNumber, bankCode } = req.body
    try {
      const response = await axios.post(`${flutterwaveBaseURL}accounts/resolve`, {
        account_number: accountNumber,
        account_bank: bankCode,
      }, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });
      // console.log(response.data.data)

      res.status(200).json({
        message: response.data.message,
        data: response.data.data.account_name
      });
      //   });

    } catch (error) {
      console.error('Error during verification:', error.response ? error.response.data : error.message);
      res.status(500).send('Internal Server Error');
    }
  },

  cancelPremiumPlan: async (req, res) => {
    const userId = req.params.userId

    try {

      const user = await User.findById(userId)
      console.log(user.flutterwaveSubscriptionId);

      if (!user) {
        return res.status(404).json({ message: "User not found" })
      }

      if (!user.premiumPlan || user.premiumPlan === "basic") {
        return res.status(400).json({ message: "No active premium plan to cancel" })
      }


      user.premiumPlan = "basic"

      try {
        // Make API call to Flutterwave to cancel subscription
        const response = await axios.put(
          `${flutterwaveBaseURL}subscriptions/${user.flutterwaveSubscriptionId}/cancel`,
          {},
          {
            headers: {
              Authorization: `Bearer ${flutterwaveSecretKey}`,
            },
          },
        )

        console.log("Flutterwave cancellation response:", response.data)

        // Clear the subscription ID
        user.flutterwaveSubscriptionId = null
      } catch (flwError) {
        // Log the error but continue with local cancellation
        console.error(
          "Error canceling Flutterwave subscription:",
          flwError.response ? flwError.response.data : flwError.message,
        )
      }


      // Save the updated user
      await user.save()

      // Create a record in transaction history
      await Transaction.create({
        userId: user._id,
        type: "subscription_cancellation",
        amount: 0,
      })

      // Send success response
      return res.status(200).json({
        message:
          "Your premium plan has been canceled successfully. You will have access until the end of your current billing period.",
      })
    } catch (error) {
      console.error("Error canceling premium plan:", error)
      return res.status(500).json({ message: "Internal server error" })
    }
  },
  createRecipient: async (req, res) => {
    const { userId, bankCode, accountNumber } = req.body;

    try {
      const user = await User.findById(userId);

      user.bankCode = bankCode;
      user.accountNumber = accountNumber
      await user.save();
      if (!user) {
        return res.status(404).send('User not found');
      }

      const response = await axios.post(`${flutterwaveBaseURL}beneficiaries`, {
        account_bank: bankCode,
        account_number: accountNumber,
        currency: 'NGN',
        beneficiary_name: user.fullname,
      }, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });

      // console.log(response.data.data)

      res.status(200).json({ message: 'Recipient created', recipientCode: user.flutterwaveRecipientCode });
    } catch (error) {
      console.error('Error creating recipient:', error.response ? error.response.data : error.message);
      res.status(500).send('Internal Server Error');
    }
  },

  withdraw: async (req, res) => {
    const { userId, amount } = req.body;

    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }

      if (user.balance < amount) {
        return res.status(400).send('Insufficient balance');
      }

      const response = await axios.post(`${flutterwaveBaseURL}transfers`, {
        account_bank: user.bankCode,
        account_number: user.accountNumber, // You should store the user's account number
        amount,
        narration: 'Withdrawal',
        currency: 'NGN',
        reference: `tx-${Date.now()}`
      }, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });

      if (response.data.status === 'success') {
        // Deduct amount from user balance

        user.balance -= amount;
        await user.save();

        await Transaction.create({
          userId: user._id,
          amount: amount,
          type: 'debit'
        })

        return res.status(200).json({ message: 'Withdrawal successful' });
      }

      res.status(200).json({ message: response.data.message });
    } catch (error) {
      console.error('Error during withdrawal:', error.response ? error.response.data : error.message);
      res.status(500).send(error.response.data.message);
    }
  },

  addFunds: async (req, res) => {
    const { userId, amount } = req.body;
    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }

      user.balance += amount;
      await user.save();

      await Transaction.create({
        userId: user._id,
        amount: amount,
        type: 'credit'
      })

      return res.status(200).json({ message: 'Funds Added successfully' });
    } catch (error) {
      // console.error('Error during withdrawal:', error.response ? error.response.data : error.message);
      res.status(500).send(error.response.data.message);
    }
  },

  payWith: async (req, res) => {
    const { userId, amount } = req.body;
    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }
      if (user.balance < amount) {
        return res.status(400).send('Insufficient balance');
      }

      user.balance -= amount;
      await user.save();

      await Transaction.create({
        userId: user._id,
        amount: amount,
        type: 'debit'
      })

      return res.status(200).json({ message: 'Payment Made successfully' });

    } catch (error) {
      res.status(500).send(error.response.data.message);
    }
  }
}


module.exports = transactionController;

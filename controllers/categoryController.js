const Category = require("../models/category.js");

const categoryController = {
  createCategory: async (req, res) => {
    try {
      const category = await Category.create(req.body)

      return res.status(201).json({
        success: true,
        message: 'Category added successfully',
        category,
      });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error during category creation' });
    }
  },
  
  getAllCategory: async (req, res) => {
    try {
      const category = await Category.find()

      return res.status(200).json({ category });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error during category retrival' });
    }
  },

  editCategory: async (req, res) => {
    try {
      const course = await Category.updateOne({
        _id: req.params.id
      }, {
        ...req.body
      }, {
        new: true
      })
      res.json(course);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },
  deleteCategory: async (req, res) => {
    try {
      const course = await Category.deleteOne({
        _id: req.params.id
      })
      res.json(course);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  }
}
module.exports = categoryController;
